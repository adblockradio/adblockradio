// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { Writable } = require("stream");
const { log } = require("abr-log")("pred-ml");
const cp = require("child_process");
const assert = require("assert");

const fs = require("fs-extra");

function parse(msg) {
	try {
		return JSON.parse(msg);
	} catch (e) {
		log.error(self.canonical + ' could not parse response. msg=' + msg);
		return null;
	}
}

class MlPredictor extends Writable {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		this.verbose = options.verbose || false;
		this.ready = false; // becomes true when ML model is loaded
		this.modelFile = options.modelFile;
		//this.ready2 = false; // becomes true when audio data is piped to this module. managed externally
		//this.finalCallback = null;
		//this.readyToCallFinal = false;
		this.dataWrittenSinceLastSeg = false;
		this.JSPredictorMl = !!options.JSPredictorMl;

		this.load = this.load.bind(this);
		this.predict = this.predict.bind(this);

		const self = this;
		(async function() {
			await self.load();
			if (options.callback) options.callback();
		})();
	}

	async load() {
		const self = this;
		if (this.JSPredictorMl) { // Javascript MFCC & Tensorflow: tfjs (pure JS) or node-tfjs (native lib and Node bindings)

			log.info(this.canonical + " JS predictor");
			await new Promise(function(resolve, reject) {
				self.child = cp.fork(__dirname + '/ml-worker.js', {
					env: {
						canonical: self.canonical,
						modelFile: self.modelFile,
					}
				});

				self.child.once('message', function(msg) {
					msg = parse(msg);
					assert.equal(msg.type, 'loading');
					if (msg.err) {
						log.warn(self.canonical + ' could not load model: ' + JSON.stringify(msg));
						return reject();
					}
					self.ready = msg.loaded;
					log.info(self.canonical + ' loaded=' + self.ready);
					resolve();
				});
			});

		} else { // Python MFCC & Tensorflow

			const isPKG = __dirname.indexOf("/snapshot/") === 0 || __dirname.indexOf("C:\\snapshot\\") === 0; // in a PKG environment (https://github.com/zeit/pkg)
			const isElectron = !!(process && process.versions['electron']); // in a Electron environment (https://github.com/electron/electron/issues/2288)

			log.info(this.canonical + " Python predictor. __dirname=" + __dirname + " env: PKG=" + isPKG + " Electron=" + isElectron);

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
					try {
						await fs.access(path);
						log.info("mlpredict found at " + path);
						this.predictChild = cp.spawn(path, [ this.canonical ], { stdio: ['pipe', 'pipe', 'pipe']});
						break;
					} catch (e) {
						// pass
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

			const zerorpc = require("zerorpc");
			// increase default timeouts, otherwise this would fail at model loading on some CPU-bound devices.
			// https://github.com/0rpc/zerorpc-node#clients
			this.client = new zerorpc.Client({ timeout: 120, heartbeatInterval: 60000 });
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
				//self.readyToCallFinal = true;
				//if (self.finalCallback) self.finalCallback();
			});

			await new Promise(function(resolve, reject) {
				self.client.invoke("load", self.modelFile, function(error, res, more) {
					if (error) {
						if (error === "model not found") {
							log.error(self.canonical + " Keras ML file " + self.modelFile + " not found. Cannot tag audio");
						} else {
							log.error(error);

							// TODO has occasionally thrown:
							// "Initializer for variable lstm_1_2/kernel/ is from inside a control-flow construct,
							// such as a loop or conditional. When creating a variable inside a loop or conditional,
							// use a lambda as the initializer."
							//
							// but cannot reproduce :/
						}
						return reject();
					}

					log.info(self.canonical + " predictor process is ready to crunch audio");
					self.ready = true;
					return resolve();
				});
			});
		}
	}

	_write(buf, enc, next) {
		if (this.JSPredictorMl && this.child && this.ready) {
			this.child.send(JSON.stringify({
				type: 'write',
				buf: buf,
			}));

		} else if (!this.JSPredictorMl && this.client && this.predictChild && this.ready) {
			this.dataWrittenSinceLastSeg = true;
			const self = this;
			this.client.invoke("write", buf, function(err, res, more) {
				if (err) {
					log.error(self.canonical + " _write client returned error=" + err);
				}
			});
		}
		next();
	}

	predict(callback) {
		const self = this;
		if (this.JSPredictorMl && this.child && this.ready) {
			this.child.send(JSON.stringify({
				type: 'predict',
			}));
			this.child.once('message', function(msg) {
				msg = parse(msg);
				assert.equal(msg.type, 'predict');
				if (msg.err) log.warn(self.canonical + ' skipped prediction: ' + JSON.stringify(msg));
				callback(null, msg.outData);
			});

		} else if (!this.JSPredictorMl && this.client && this.predictChild && this.ready) {
			if (!this.dataWrittenSinceLastSeg) {
				//if (this.ready2) log.warn(this.canonical + " skip predict as no data is available for analysis");
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
					//log.debug("perf: nwin=" + results.nwin + " pre=" + results.timings.pre + " tf=" + results.timings.tf + " post=" + results.timings.post + " total=" + results.timings.total);
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

				callback(null, outData);
			});
		} else {
			callback(null);
		}
	}

	_final() {
		if (this.JSPredictorMl) {
			if (this.child) {
				this.child.kill();
				log.info(this.canonical + " killed child process.");
			}
		} else {
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
			//this.readyToCallFinal = next;
		}
	}
}

module.exports = MlPredictor;
