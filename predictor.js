// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { log } = require("abr-log")("predictor");
const Hotlist = require("./predictor-db/hotlist.js");
const MlPredictor = require("./predictor-ml/ml.js");
const { StreamDl } = require("stream-tireless-baler");
const { getMeta, isAvailable } = require("webradio-metadata");
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
		this.country = options.country; 	// mandatory argument
		this.name = options.name;			// mandatory argument

		// output of predictions
		this.listener = options.listener;	// mandatory argument, instance of a Writable Stream.

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
			saveAudioPath: __dirname + '/records', // root folder where audio and metadata are saved
			fetchMetadata: true, // gather metadata from radio websites (saveDuration intervals)
			modelPath: __dirname + '/model', // directory where ML models and hotlist DBs are stored
		}

		// optional custom config
		Object.assign(this.config, options.config);

		// check that the metadata fetch module has a parser for this stream
		if (this.config.fetchMetadata) {
			if (isAvailable(this.country, this.name)) {
				log.info(this.country + "_" + this.name + " metadata is available for this stream");
			} else {
				log.warn(this.country + "_" + this.name + " metadata is not available for this stream. will not fetch it.");
				this.config.fetchMetadata = false;
			}
		}

		log.info(this.country + "_" + this.name + " run predictor with config=" + JSON.stringify(this.config));

		this._onData = this._onData.bind(this);
		this._newAudioSegment = this._newAudioSegment.bind(this);

		var self = this;
		this.dl = new StreamDl({ country: this.country, name: this.name, segDuration: self.config.predInterval });
		this.dl.on("error", function(err) {
			log.error(self.country + "_" + self.name + " dl err=" + err);
		});
		this.dl.pause();

		this.decoder = require('child_process').spawn('ffmpeg', [
			'-i', 'pipe:0',
			'-acodec', 'pcm_s16le',
			'-ar', 22050,
			'-ac', 1,
			'-f', 'wav',
			'-v', 'fatal',
			'pipe:1'
		], { stdio: ['pipe', 'pipe', process.stderr] });

		this.refreshPredictorHotlist();
		this.refreshPredictorMl();

		this.dl.on("metadata", function(metadata) { // this happens once at the beginning of stream download
			log.info(self.country + "_" + self.name + " metadata=" + JSON.stringify(metadata));

			self.listener.write({ type: "dlinfo", data: metadata });

			self.audioExt = metadata.ext;

			self.dbs = null;
			self.predCounter = 0

			self._newAudioSegment(function() {
				self.dl.resume();
			});

			self.dl.on("data", self._onData);
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
			self.listener.write(Object.assign(dataObj, {
				type: "audio",
				metadataPath: self.dbs.metadataPath
			}));
			self.decoder.stdin.write(dataObj.data);
		}

		if (!dataObj.newSegment) return out();

		// actions on new segment
		//log.debug("dl+decoder pause");

		this.dl.pause();
		self.decoder.stdout.pause();

		// TODO: do the hotlist search only if mlPredictor is unsure?

		async.parallel([

			function(cb) {
				return self.config.enablePredictorMl && self.mlPredictor.ready ? self.mlPredictor.predict(cb) : setImmediate(cb);
			},
			function(cb) {
				return self.config.enablePredictorHotlist ? self.hotlist.onFingers(cb) : setImmediate(cb);
			}

		], function(err) {

			if (err) log.warn(self.country + "_" + self.name + " a predictor returned the following error: " + JSON.stringify(err));

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

		if (this.config.enablePredictorMl && this.mlPredictor.ready && !this.mlPredictor.ready2) {
			// this happens only once, when mlPredictor is ready to crunch data
			log.info(this.country + "_" + this.name + ": piping audio to mlPredictor");
			this.decoder.stdout.pipe(this.mlPredictor);
			this.mlPredictor.ready2 = true;
		}

		const self = this;

		const now = new Date();
		const dirDate = (now.getUTCFullYear()) + "-" + (now.getUTCMonth()+1 < 10 ? "0" : "") + (now.getUTCMonth()+1) + "-" + (now.getUTCDate() < 10 ? "0" : "") + (now.getUTCDate());
		const dir = this.config.saveAudioPath + '/' + dirDate + "/" + this.country + "_" + this.name + "/todo/";
		const path = dir + now.toISOString();

		//log.debug("saveAudioSegment: path=" + path);

		cp.exec("mkdir -p \"" + dir + "\"", function(error, stdout, stderr) {
			if (error) {
				log.error("warning, could not create path " + path);
			}

			self.dbs = {
				audio: self.config.saveAudio ? new fs.createWriteStream(path + "." + self.audioExt) : null,
				metadataPath: path + ".json"
			};

			// TODO put fetch metadata out of this process, it may delay it.
			// but... metadata may be an ingredient to help the algorithm. so it shall stay here.
			if (self.config.fetchMetadata) {
				getMeta(self.country, self.name, function(err, parsedMeta, corsEnabled) {
					if (err) return log.warn(self.country + "_" + self.name + ": getMeta: error fetching title meta. err=" + err);
					//log.info(self.country + "_" + self.name + " meta=" + JSON.stringify(parsedMeta));
					self.listener.write({ type: "title", data: parsedMeta });
				});
			}
			callback();
		});
	}

	refreshPredictorHotlist() {
		if (this.hotlist) {
			this.hotlist.unpipe(this.listener);
			this.decoder.stdout.unpipe(this.hotlist);
			this.hotlist.destroy();
			delete this.hotlist;
		}
		if (this.config.enablePredictorHotlist) {
			this.hotlist = new Hotlist({
				country: this.country,
				name: this.name,
				fileDB: this.config.modelPath + '/' + this.country + '_' + this.name + '.sqlite'
			});
			this.hotlist.pipe(this.listener);
			this.decoder.stdout.pipe(this.hotlist);
		} else {
			this.hotlist = null;
		}
	}

	refreshPredictorMl() {
		if (this.mlPredictor) {
			this.mlPredictor.unpipe(this.listener);
			if (this.mlPredictor.ready2) this.decoder.stdout.pipe(this.mlPredictor);
			this.mlPredictor.destroy();
			delete this.mlPredictor;
		}
		if (this.config.enablePredictorMl) {
			this.mlPredictor = new MlPredictor({
				country: this.country,
				name: this.name,
				fileModel: this.config.modelPath + '/' + this.country + '_' + this.name + '.keras'
			});
			this.mlPredictor.pipe(this.listener);
			// we pipe decoder to mlPredictor later, once mlPredictor is ready to process data.
		} else {
			this.mlPredictor = null;
		}
	}

	stop() {
		log.info(this.country + "_" + this.name + " close predictor");

		if (this.mlPredictor) {
			log.debug("unpipe decoder stdout and mlPredictor");
			this.decoder.stdout.unpipe(this.mlPredictor);
		}

		log.debug("will stop dl");
		this.dl.stopDl();

		log.debug("will stop decoder");
		this.decoder.kill();

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