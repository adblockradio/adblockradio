// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { log } = require("abr-log")("predictor");
const { Readable } = require("stream");
const Hotlist = require("./predictor-db/hotlist.js");
const MlPredictor = require("./predictor-ml/ml.js");
const async = require("async");
const cp = require("child_process");
const fs = require("fs");

class ChunkAudioRead extends Readable {
	constructor(options) {
		options.objectMode = true;
		super(options);

		this.file = options.file;
		this.predInterval = options.predInterval;
		const self = this;

		this.decoder = cp.spawn('ffmpeg', [
			'-i', 'pipe:0',
			'-acodec', 'pcm_s16le',
			'-ar', 22050,
			'-ac', 1,
			'-f', 'wav',
			'-v', 'fatal',
			'pipe:1'
		], { stdio: ['pipe', 'pipe', process.stderr] });

		fs.createReadStream(self.file).pipe(this.decoder.stdin);

		const bitrate = 22050 * 2; // bytes per second. (16 bit, single channel)
		const readAmount = Math.round(self.predInterval * bitrate);
		log.debug('readAmount=' + readAmount + ' bytes');
		let bytesRead = 0;
		this.decoder.stdout.on('readable', function() {
			let chunk;
			while (null !== (chunk = self.decoder.stdout.read(readAmount))) {
				//log.info('Append chunk of ' + readAmount + ' bytes of data.');

				bytesRead += chunk.length;
				self.push({
					data: chunk,
					tStart: Math.round((bytesRead - chunk.length) / (bitrate) * 1000), // in ms
					tEnd: Math.round(bytesRead / (bitrate) * 1000), // in ms
				});
			}
		});

		this.decoder.stdout.on('end', function() {
			log.info("decoding finished");
			self.push(null);
		});
	}

	_read() {
		// Le silence éternel de ces espaces infinis m’effraie.
	}
}

class PredictorFile {
	constructor(options) {
		// stream identification
		this.country = options.country; 	// mandatory argument
		this.name = options.name;			// mandatory argument
		this.file = options.file;			// mandatory argument

		// output of predictions
		this.listener = options.listener;	// mandatory argument, instance of a Writable Stream.

		if (!this.country || !this.name || !this.listener || !this.file) {
			return log.error("Predictor needs to be constructed with: country (string), name (string), listener (Writable stream) and file (string)");
		}

		// default module options
		this.config = {
			predInterval: 1, // send stream status to listener every N seconds
			enablePredictorMl: true, // perform machine learning inference (at "predInterval" intervals)
			enablePredictorHotlist: true, // compute audio fingerprints and search them in a DB (at "predInterval" intervals)
			modelPath: __dirname + '/model', // directory where ML models and hotlist DBs are stored
			file: null, // analyse a file directly, instead of downloading a stream
		}

		// optional custom config
		Object.assign(this.config, options.config);

		log.info("run predictor on file " + this.file + " with config=" + JSON.stringify(this.config));

		this._onData = this._onData.bind(this);

		this.startPredictorHotlist();
		this.startPredictorMl();

		const self = this;

		this.input = new ChunkAudioRead({ file: this.config.file, predInterval: this.config.predInterval });
		this.input.on("error", (err) => log.error("read err=" + err));
		this.input.pause();

		this.input.on("data", self._onData);

		this.input.on("end", function() {
			log.info("all data has been read");
			self.readFinished = true;
		});

		this.mlPredictor.onReadyCallback = () => this.input.resume();

	}

	_onData(dataObj) {
		const self = this;
		this.input.pause();

		// TODO: do the hotlist search only if mlPredictor is unsure?

		async.parallel([

			function(cb) {
				if (!self.config.enablePredictorMl) return setImmediate(cb);
				self.mlPredictor.write(dataObj.data);
				self.mlPredictor.predict(cb);
			},
			function(cb) {
				if (!self.config.enablePredictorHotlist) return setImmediate(cb);
				self.hotlist.write(dataObj.data);
				self.hotlist.onFingers(cb);
			}

		], function(err) {
			if (err) log.warn("a predictor returned the following error: " + JSON.stringify(err));

			// we package all the results in listener's cache data into an object that will go in postProcessing
			self.listener.write(Object.assign(dataObj, {
				type: "fileChunk",
				metadataPath: self.config.file + ".json"
			}));
			if (self.readFinished) {
				self.stopPredictors();
				self.listener.end();
			} else {
				self.input.resume();
			}
		});
	}

	startPredictorHotlist() {
		if (this.config.enablePredictorHotlist) {
			this.hotlist = new Hotlist({
				country: this.country,
				name: this.name,
				fileDB: this.config.modelPath + '/' + this.country + '_' + this.name + '.sqlite'
			});
			this.hotlist.pipe(this.listener);
		} else {
			this.hotlist = null;
		}
	}

	startPredictorMl() {
		if (this.config.enablePredictorMl) {
			this.mlPredictor = new MlPredictor({
				country: this.country,
				name: this.name,
				fileModel: this.config.modelPath + '/' + this.country + '_' + this.name + '.keras'
			});
			this.mlPredictor.pipe(this.listener);
		} else {
			this.mlPredictor = null;
		}
	}

	stopPredictors() {
		log.info("close predictor");
		if (this.hotlist) this.hotlist.destroy();
		if (this.mlPredictor) this.mlPredictor.destroy();
	}
}


module.exports = PredictorFile;