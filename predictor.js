// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { log } = require("abr-log")("predictor");
const Hotlist = require("./predictor-db/hotlist.js");
const MlPredictor = require("./predictor-ml/ml.js");
const { StreamDl } = require("stream-tireless-baler");
let { getMeta, isAvailable } = require(process.cwd() + "/webradio-metadata.js");
const async = require("async");
const cp = require("child_process");
const fs = require("fs");


/* overview of operations

dl: get http data, emits "newSegment" events. ——> listener (dlinfo, audio)
| |
| |
| —> if saveAudio: save to disk
|
V
decoder: converts http data to PCM audio samples.
| |
| |
| –> if enablePredictorMl:       mlPredictor ––> listener (ml)
|
––—> if enablePredictorHotlist:  hotlist     ––> listener (hotlist)


on each dl's "newSegment" event:
if fetchMetadata: getMeta                    ––> listener (title)

*/

class Predictor {
	constructor(options) {
		// stream identification
		this.country = options.country;     // mandatory argument
		this.name = options.name;           // mandatory argument

		// paths for ML model and hotlist DB
		this.modelFile = options.modelFile; // mandatory argument if ML is enabled, ignored otherwise
		this.hotlistFile = options.hotlistFile; // mandatory argument if ML is enabled, ignored otherwise

		// output of predictions
		this.listener = options.listener;   // mandatory argument, instance of a Writable Stream.

		if (!this.country || !this.name || !this.listener) {
			return log.error("Predictor needs to be constructed with: country (string), name (string) and listener (Writable stream)");
		}

		// default module options
		this.config = {
			predInterval: 1, // send stream status to listener every N seconds
			saveDuration: 10, // save audio file and metadata every N **predInterval times**.
			enablePredictorMl: true, // perform machine learning inference (at "predInterval" intervals)
			enablePredictorHotlist: true, // compute audio fingerprints and search them in a DB (at "predInterval" intervals)
			saveAudio: true, // save stream audio data in segments on hard drive (saveDuration intervals)
			saveAudioPath: process.cwd() + '/records', // root folder where audio and metadata are saved
			fetchMetadata: true, // gather metadata from radio websites (saveDuration intervals)
			waitAfterMlModelLoad: 0, // (ms) in CPU-bound systems, wait between ML model load and audio pipe to not overwhelm the system
		}

		// optional custom config
		Object.assign(this.config, options.config);

		this.canonical = this.country + "_" + this.name; // radio name in logs

		// check that the metadata fetch module has a parser for this stream
		if (this.config.fetchMetadata) {
			if (isAvailable(this.country, this.name)) {
				log.info(this.canonical + " metadata is available for this stream");
				this.willFetchMetadata = true;
			} else {
				log.warn(this.canonical + " metadata is not available for this stream. will not fetch it.");
				this.willFetchMetadata = false;
			}
		}

		log.info(this.canonical + " run predictor with config=" + JSON.stringify(this.config) + " modelFile=" + this.modelFile + " hotlistFile=" + this.hotlistFile);

		this._onData = this._onData.bind(this);
		this._newAudioSegment = this._newAudioSegment.bind(this);

		const self = this;
		this.dl = new StreamDl({ country: this.country, name: this.name, segDuration: self.config.predInterval });
		this.dl.on("error", function(err) {
			log.error(self.canonical + " dl err=" + err);
		});
		this.dl.pause();

		this.decoder = cp.spawn('ffmpeg', [
			'-i', 'pipe:0',
			'-acodec', 'pcm_s16le',
			'-ar', 22050,
			'-ac', 1,
			'-f', 'wav',
			'-v', 'fatal',
			'pipe:1'
		], { stdio: ['pipe', 'pipe', process.stderr] });

		this.refreshPredictorHotlist = this.refreshPredictorHotlist.bind(this);
		this.refreshPredictorHotlist();
		this.refreshPredictorMl = this.refreshPredictorMl.bind(this);
		this.refreshPredictorMl();
		this.refreshMetadata = this.refreshMetadata.bind(this);

		this.dbs = null;
		this.dl.on("metadata", function(metadata) {
			log.info(self.canonical + " metadata=" + JSON.stringify(metadata));
			if (self.listener.writable) {
				self.listener.write({ type: "dlinfo", data: metadata });
			} else {
				log.warn("Could not pass metadata to listener because it is not writable");
			}
			self.audioExt = metadata.ext;

			if (!self.dbs) {
				// this happens once at the beginning of stream download.
				// if the download recovers from a temporary fail, it is not executed
				self.predCounter = 0

				self._newAudioSegment(function() {
					self.dl.on("data", self._onData);
					self.dl.resume();
				});
			}
		});

		// if things go wrong and the listener is not writable anymore, avoid pushing data to it
		this.listenerClosed = false;
		this.listener.on("close", function() {
			log.info(self.canonical + " listener closed.");
			self.listenerClosed = true;
		});
	}

	_onData(dataObj) {
		if (!this.dbs) return log.error("no dbs!!");

		//const tBuffer = dataObj.tBuffer;
		//log.debug("received " + dataObj.data.length + " bytes. newSegment=" + dataObj.newSegment);
		// dataObj.newSegment is true when the chunk of data we receive belongs to a new audio segment.
		// it happens once every [predInterval] seconds.

		const self = this;
		const out = function() {
			if (self.config.saveAudio) self.dbs.audio.write(dataObj.data);
			if (!self.listenerClosed) {
				try {
					self.listener.write(Object.assign(dataObj, {
						type: "audio",
						metadataPath: self.dbs.metadataPath
					}));
				} catch (e) {
					log.warn("could not write to listener. err=" + e);
				}
			} else {
				log.error(self.canonical + " attempt to write audio data but the listener is closed");
			}
			try {
				self.decoder.stdin.write(dataObj.data);
			} catch (e) {
				log.warn("could not write to decoder. err=" + e);
			}
		}

		if (!dataObj.newSegment) return out();

		// actions on new segment
		//log.debug("dl+decoder pause");

		this.dl.pause();
		this.decoder.stdout.pause();

		// TODO: do the hotlist search only if mlPredictor is unsure?

		async.parallel([

			function(cb) {
				if (!self.config.enablePredictorMl || !self.mlPredictor.ready) return setImmediate(cb);
				self.mlPredictor.predict(function(err, data) {
					if (!err && data && self.listener.writable) {
						self.listener.write({ type: "ml", data });
					} else {
						log.warn("skip ml result because err=" + err + " data=" + JSON.stringify(data) + " writable=" + self.listener.writable);
					}
					cb(err);
				});
			},
			function(cb) {
				if (!self.config.enablePredictorHotlist) return setImmediate(cb);
				self.hotlist.onFingers(function(err, data) {
					if (!err && data && self.listener.writable) {
						self.listener.write({ type: "hotlist", data });
					} else {
						log.warn("skip hotlist result because err=" + err + " data=" + JSON.stringify(data) + " writable=" + self.listener.writable);
					}
					cb(err);
				});
			}

		], function(err) {

			if (err) log.warn(self.canonical + " a predictor returned the following error: " + JSON.stringify(err));

			// save audio and metadata less frequently than status updates. to do so, we count the audio segments.
			self.predCounter += 1;
			//log.debug("new segment. predcounter=" + self.predCounter + "/" + self.config.saveDuration);

			const finish = function() {
				//log.debug("finish: dl+decoder resume");
				self.decoder.stdout.resume();
				self.dl.resume();
				out();
			}

			if (self.predCounter < self.config.saveDuration) {
				finish();
			} else {
				self.predCounter = 0;
				self._newAudioSegment(finish);
			}
		});
	}

	_newAudioSegment(callback) {

		if (this.dbs && this.config.saveAudio) this.dbs.audio.end();

		const self = this;

		const cb = function() {
			// TODO put fetch metadata out of this process, it may delay it.
			// but... metadata may be an ingredient to help the algorithm. so it shall stay here.
			if (self.willFetchMetadata) {
				getMeta(self.country, self.name, function(err, parsedMeta, corsEnabled) {
					if (err) return log.warn(self.canonical + ": getMeta: error fetching title meta. err=" + err);
					//log.info(self.country + "_" + self.name + " meta=" + JSON.stringify(parsedMeta));
					if (!self.listenerClosed) {
						try {
							self.listener.write({ type: "title", data: parsedMeta });
						} catch (e) {
							log.error(self.canonical + " attempt to write title data but err=" + e);
						}
					} else {
						log.error(self.canonical + " attempt to write title data but the listener is closed");
					}
				});
			}
		}

		if (!this.config.saveAudio && !this.config.saveMetadata) {
			self.dbs = {
				audio: null,
				metadataPath: null
			};
			cb();
			callback();

		} else {

			const now = new Date();
			const dirDate = (now.getUTCFullYear()) + "-" + (now.getUTCMonth()+1 < 10 ? "0" : "") + (now.getUTCMonth()+1) + "-" + (now.getUTCDate() < 10 ? "0" : "") + (now.getUTCDate());
			const dir = this.config.saveAudioPath + '/' + dirDate + "/" + this.country + "_" + this.name + "/todo/";
			const path = dir + now.toISOString();
			//log.debug("saveAudioSegment: path=" + path);

			fs.mkdir(dir, { recursive: true }, function(err) {
				if (err && !("" + err).includes('EEXIST')) log.error("warning, could not create path " + path + " err=" + err);
				self.dbs = {
					audio: self.config.saveAudio ? new fs.createWriteStream(path + "." + self.audioExt) : null,
					metadataPath: path + ".json"
				};
				cb();
				callback();
			});
		}
	}

	refreshPredictorHotlist() {
		log.info(this.canonical + " refresh hotlist predictor");
		if (this.hotlist) {
			this.decoder.stdout.unpipe(this.hotlist);
			this.hotlist.destroy();
			delete this.hotlist;
		}
		if (this.config.enablePredictorHotlist) {
			this.hotlist = new Hotlist({
				country: this.country,
				name: this.name,
				fileDB: this.hotlistFile,
			});
			this.decoder.stdout.pipe(this.hotlist);
		} else {
			this.hotlist = null;
		}
	}

	async refreshPredictorMl() {
		log.info(this.canonical + " refresh ML predictor");
		if (this.config.enablePredictorMl && !this.mlPredictor) {
			this.mlPredictor = new MlPredictor({
				country: this.country,
				name: this.name,
				modelFile: this.modelFile,
			});
			this.decoder.stdout.pipe(this.mlPredictor);
		}
		if (this.config.enablePredictorMl) {
			await this.mlPredictor.load();
			// we pipe decoder into mlPredictor later, once mlPredictor is ready to process data. the flag for this is mlPredictor.ready2
			/*const self = this;
			this.mlPredictor.ready2 = false;
			this.mlPredictor.load(this.modelFile, function(err) {
				if (err && ("" + err).indexOf("Lost remote after 30000ms") >= 0) {
					log.warn(self.canonical + " lost remote Python worker. will restart it");
					self.mlPredictor.destroy();
					self.refreshPredictorMl();

				} else if (err) {
					return log.error(self.canonical + " could not load ML model. err=" + err);
				}
				setTimeout(function() {
					if (self.config.enablePredictorMl && self.mlPredictor.ready && !self.mlPredictor.ready2) {
						log.info(self.canonical + ": piping audio to mlPredictor");
						self.decoder.stdout.pipe(self.mlPredictor);
						self.mlPredictor.ready2 = true;
					} else {
						log.error(self.canonical + " refreshPredictorML config has changed during model loading!?");
					}
				}, self.config.waitAfterMlModelLoad); // to not overwhelm the CPU in CPU-bound systems
			*/
		} else {
			if (this.mlPredictor) {
				if (this.mlPredictor.ready2) this.decoder.stdout.unpipe(this.mlPredictor);
				this.mlPredictor.destroy();
				this.mlPredictor = null;
			}
		}
	}

	refreshMetadata() {
		log.info(this.canonical + " refresh metadata scraper");
		delete require.cache[require.resolve('./webradio-metadata.js')];
		getMeta = require(process.cwd() + "/webradio-metadata.js").getMeta;
	}

	stop() {
		log.info(this.canonical + " close predictor");

		if (this.mlPredictor) {
			log.debug("unpipe decoder stdout and mlPredictor");
			this.decoder.stdout.unpipe(this.mlPredictor);
		}

		log.debug("will stop dl");
		this.dl.stopDl();

		log.debug("will stop decoder");
		this.decoder.stdin.end();

		if (this.hotlist) {
			log.debug("will close hotlist");
			this.hotlist.end();
		} else {
			log.debug("no hotlist to close");
		}
		if (this.mlPredictor) {
			log.debug("will close ML predictor");
			this.mlPredictor.end();
		} else {
			log.debug("no ML predictor to close");
		}
	}
}


module.exports = Predictor;