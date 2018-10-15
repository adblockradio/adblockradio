// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { Transform } = require("stream");
const cp = require("child_process");
const { log } = require("abr-log")("pred-ml");
const zerorpc = require("zerorpc");

class MlPredictor extends Transform {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		this.fileModel = options.fileModel || __dirname + "/model/" + this.canonical + ".keras";
		this.ready = false;
		this.onReadyCallback = options.onReadyCallback;
		const self = this;
		this.finalCallback = null;
		this.readyToCallFinal = false;
		this.dataWrittenSinceLastSeg = false;
		this.onDataCallback = null;

		// spawn python subprocess
		this.cork();
		this.predictChild = cp.spawn('python', [
			'-u',
			__dirname + '/mlpredict.py',
			this.canonical,
		], { stdio: ['pipe', 'pipe', 'pipe'] });

		this.client = new zerorpc.Client();
		this.client.connect("ipc:///tmp/" + this.canonical);

		this.client.on("error", function(error) {
			log.error("RPC client error:", error);
		});

		this.client.invoke("load", this.fileModel, function(error, res, more) {
			if (error && error === "model not found") {
				return log.error(self.canonical + " Keras ML file not found. Cannot tag audio");
			} else if (error) {
				return log.error(error);
			}

			log.info(self.canonical + " predictor process is ready to crunch audio");
			self.ready = true;
			if (self.onReadyCallback) self.onReadyCallback();
			return self.uncork();
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

	_write(buf, enc, next) {
		this.dataWrittenSinceLastSeg = true;
		this.client.invoke("write", buf, function(err, res, more) {
			if (err) {
				log.error("_write client returned error=" + err);
			}
		});
		next();
	}

	predict(callback) {
		const self = this;
		if (!this.dataWrittenSinceLastSeg) {
			log.debug("skip predict as no data is available for analysis");
			return callback();
		}
		this.dataWrittenSinceLastSeg = false;
		this.client.invoke("predict", function(err, res, more) {
			if (err) {
				log.error("_sendStopWord: predict() returned error=" + err);
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
			callback(null);
		});
	}

	_final(next) {
		log.info("closing ML predictor");

		this.client.invoke("exit", function(err, res, more) {
			if (err) {
				log.error("_final: exit() returned error=" + err);
			}
		});

		// if not enough, kill it directly!
		this.predictChild.stdin.end();
		this.predictChild.kill();

		//if (this.readyToCallFinal) return next();
		this.readyToCallFinal = next;
	}
}

module.exports = MlPredictor;
