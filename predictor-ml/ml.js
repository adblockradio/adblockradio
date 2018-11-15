// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { Transform } = require("stream");
const cp = require("child_process");
const { log } = require("abr-log")("pred-ml");
const zerorpc = require("zerorpc");
const fs = require("fs");

class MlPredictor extends Transform {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		this.ready = false; // becomes true when ML model is loaded
		this.ready2 = false; // becomes true when audio data is piped to this module. managed externally
		this.finalCallback = null;
		this.readyToCallFinal = false;
		this.dataWrittenSinceLastSeg = false;

		this.spawn();
	}

	spawn() { // spawn python subprocess
		const self = this;
		log.info("__dirname=" + __dirname);

		const isPKG = __dirname.indexOf("/snapshot/") === 0 || __dirname.indexOf("C:\\snapshot\\") === 0; // in a PKG environment (https://github.com/zeit/pkg)
		const isElectron = !!(process && process.versions['electron']); // in a Electron environment (https://github.com/electron/electron/issues/2288)

		log.info("env: PKG=" + isPKG + " Electron=" + isElectron);

		if (isPKG) {
			this.predictChild = cp.spawn(process.cwd() + "/dist/mlpredict/mlpredict",
				[ this.canonical ], { stdio: ['pipe', 'pipe', 'pipe']});
		} else if (isElectron) {
			const paths = [
				"",
				"/Adblock Radio Buffer-linux-x64/resources/app"
			];

			for (let i=0; i<paths.length; i++) {
				const path = process.cwd() + paths[i] + "/node_modules/adblockradio/predictor-ml/dist/mlpredict/mlpredict"
				const stat = fs.statSync(path);
				if (stat.isFile()) {
					this.predictChild = cp.spawn(path, [ this.canonical ], { stdio: ['pipe', 'pipe', 'pipe']});
					break;
				}
				if (i === paths.length - 1) {
					const msg = "Could not locate mlpredict. cwd=" + process.cwd() + " paths=" + JSON.stringify(paths);
					log.error(msg);
					throw new Error(msg);
				}
			}

		} else {
			this.predictChild = cp.spawn('python', [
				'-u',
				__dirname + '/mlpredict.py',
				this.canonical,
			], { stdio: ['pipe', 'pipe', 'pipe'] });
		}
		// increase default timeouts, otherwise this would fail at model loading on some CPU-bound devices.
		// https://github.com/0rpc/zerorpc-node#clients
		this.client = new zerorpc.Client({ timeout: 60, heartbeatInterval: 15000 });
		this.client.connect("ipc:///tmp/" + this.canonical);

		this.client.on("error", function(error) {
			log.error(self.canonical + " RPC client error:" + error);
		});

		this.predictChild.stdout.on('data', function(msg) { // received messages from python worker
			const msgS = msg.toString().split("\n");

			// sometimes, several lines arrive at once. separate them.
			for (let i=0; i<msgS.length; i++) {
				if (msgS[i].length > 0) log.debug(msgS[i]);
			}
		});

		this.predictChild.stderr.on("data", function(msg) {
			if (msg.includes("Using TensorFlow backend.")) return;
			log.error(self.canonical + " mlpredict child stderr data: " + msg);
		});
		this.predictChild.stdin.on("error", function(err) {
			log.warn(self.canonical + " mlpredict child stdin error: " + err);
		});
		this.predictChild.stdout.on("error", function(err) {
			log.warn(self.canonical + " mlpredict child stdout error: " + err);
		});
		this.predictChild.stderr.on("error", function(err) {
			log.warn(self.canonical + " mlpredict child stderr error: " + err);
		});
		this.predictChild.stdout.on("end", function() {
			//log.debug("cp stdout end");
			self.readyToCallFinal = true;
			if (self.finalCallback) self.finalCallback();
		});
	}

	load(fileModel, callback) {
		const self = this;
		this.cork();
		this.ready = false;
		this.client.invoke("load", fileModel, function(error, res, more) {
			if (error) {
				if (error === "model not found") {
					log.error(self.canonical + " Keras ML file not found. Cannot tag audio");
				} else {
					log.error(error);
				}
				return callback(error);
			}

			log.info(self.canonical + " predictor process is ready to crunch audio");
			self.ready = true;
			self.uncork();
			return callback(null);
		});
	}

	_write(buf, enc, next) {
		this.dataWrittenSinceLastSeg = true;
		const self = this;
		this.client.invoke("write", buf, function(err, res, more) {
			if (err) {
				log.error(self.canonical + " _write client returned error=" + err);
			}
		});
		next();
	}

	predict(callback) {
		const self = this;
		if (!this.dataWrittenSinceLastSeg) {
			if (this.ready2) log.warn(this.canonical + " skip predict as no data is available for analysis");
			return callback();
		}
		this.dataWrittenSinceLastSeg = false;
		this.client.invoke("predict", function(err, res, more) {
			if (err) {
				log.error(self.canonical + " predict() returned error=" + err);
				return callback(err);
			}
			try {
				var results = JSON.parse(res);
				//log.debug("results=" + JSON.stringify(results))
			} catch(e) {
				log.error(self.canonical + " could not parse json results: " + e + " original data=|" + res + "|");
				return callback(err);
			}

			let outData = {
				type: results.type,
				confidence: results.confidence,
				softmaxraw: results.softmax.concat([0]), // the last class is about jingles. ML does not detect them.
				//date: new Date(stream.lastData.getTime() + Math.round(stream.tBuffer*1000)),
				gain: results.rms,
				lenPcm: results.lenpcm
			}

			self.push({ type:"ml", data: outData, array: true });
			callback(null, outData);
		});
	}

	_final(next) {
		log.info(this.canonical + " closing ML predictor");

		const self = this;
		this.client.invoke("exit", function(err, res, more) {
			if (err) {
				log.error(self.canonical + "_final: exit() returned error=" + err);
			}
		});

		this.client.close();

		// if not enough, kill it directly!
		this.predictChild.stdin.end();
		this.predictChild.kill();

		//if (this.readyToCallFinal) return next();
		this.readyToCallFinal = next;
	}
}

module.exports = MlPredictor;
