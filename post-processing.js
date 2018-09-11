// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { log } = require("abr-log")("post-processing");
const Predictor = require("./predictor.js");
const PredictorFile = require("./predictor-file.js");
const { Transform, Readable } = require("stream");
const fs = require("fs");

const consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "3-jingles"],
	UNSURE: "unsure",
	CACHE_MAX_LEN: 50,
	MOV_AVG_WEIGHTS: [
		{ "weights": [0.05, 0.05, 0.05, 0.10, 0.10, 0.15, 0.20, 0.30, 0.80, 1.00], "sum": 2.80 }, // r=0 same as ideal r=1 for very short buffers. so 1 step lag
		{ "weights": [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.70, 0.80, 1.00], "sum": 4.30 }, // r=1 same as ideal r=2 for short buffers. so 1 step lag
		{ "weights": [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.70, 0.80, 1.00], "sum": 4.30 }, // r=2
		{ "weights": [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00], "sum": 5.50 }, // r=3
		{ "weights": [0.25, 0.35, 0.50, 0.70, 0.90, 1.00, 1.00, 0.80, 0.70, 0.20], "sum": 6.20 }  // r=4
	]
}

class PostProcessor extends Transform {
	constructor(config) {
		super({ writableObjectMode: true, readableObjectMode: true });
		this.cache = [];
		this._postProcessing = this._postProcessing.bind(this);
		this.slotCounter = 0;
		this.metadata = null;
		this.metadataValidUntil = null;
		this.streamInfo = null;
		this.startTime = +new Date();
		this.config = config;
		//log.debug("fileMode=" + this.config.fileMode);
	}

	_write(obj, enc, next) {
		if (!this.cache[0]) this._newCacheSlot(0);

		switch (obj.type) {
			case "audio": // only in stream analysis mode
				if (obj.newSegment && this.cache[0] && this.cache[0].audio && this.cache[0].audio.length > 0) {
					if (this.config.verbose) log.info("in: audio => " + this.cache[0].audio.length + " bytes, tBuf=" + obj.tBuffer.toFixed(2) + "s");
					this._newCacheSlot(obj.tBuffer);
				}
				this.cache[0].audio = this.cache[0].audio ? Buffer.concat([this.cache[0].audio, obj.data]) : obj.data;
				this.cache[0].metadataPath = obj.metadataPath;
				break;

			case "fileChunk": // only in file analysis mode
				this.cache[0].audio = obj.data;
				this.cache[0].metadataPath = obj.metadataPath;
				this.cache[0].tStart = obj.tStart;	// in ms
				this.cache[0].tEnd = obj.tEnd;		// in ms
				if (this.config.verbose) log.info("in: fileChunk => " + this.cache[0].audio.length + " bytes, tStart=" + (obj.tStart / 1000).toFixed(2) + "s");
				this._newCacheSlot();
				break;

			case "ml":
				if (this.config.verbose) log.info("in: ml => type=" + consts.WLARRAY[obj.data.type] + " confidence=" + obj.data.confidence.toFixed(2) +
					" softmax=" + obj.data.softmaxs.map(e => e.toFixed(2)) + " confidence=" + obj.data.confidence.toFixed(2));
				if (this.cache[0].ml) log.warn("overwriting ml cache data!")
				this.cache[0].ml = obj.data;
				this.cache[0].gain = obj.data.gain;
				break;

			case "hotlist":
				if (this.config.verbose) log.info("in: hotlist => matches=" + obj.data.matchesSync + "/" + obj.data.matchesTotal +
					" class=" + consts.WLARRAY[obj.data.class]);
				if (this.cache[0].hotlist) log.warn("overwriting hotlist cache data!")
				this.cache[0].hotlist = obj.data;
				break;

			case "title":
				if (this.config.verbose) log.info("in: title => " + JSON.stringify(obj.data));
				this.metadata = obj.data;
				// validity: not setting a validity or setting it to zero lead to infinite validity.
				this.metadataValidUntil = obj.validity ? (+new Date() + obj.validity * 1000 * 2) : Infinity;
				break;

			case "dlinfo":
				if (this.config.verbose) log.info("in: dlinfo => " + JSON.stringify(obj.data));
				this.streamInfo = {
					url: obj.data.url,
					favicon: obj.data.favicon,
					homepage: obj.data.homepage,
					audioExt: obj.data.ext
				}
				break;

			default:
				log.warn(JSON.stringify(obj.data));
		}

		next();
	}

	_newCacheSlot(tBuffer) {

		if (this.config.verbose) log.debug("---------------------");
		const now = +new Date();
		this.slotCounter++;
		this.cache.unshift({ ts: now, audio: null, ml: null, hotlist: null, tBuf: tBuffer, n: this.slotCounter });


		if (this.config.fileMode) {
			if (this.cache.length >= 5) {
				this._postProcessing(this.cache[4].ts);
			}

		} else {
			// schedule the postprocessing for this slot, according to the buffer available.
			// "now" is used as a reference for _postProcessing, so it knows which slot to process
			// postProcessing happens 500ms before audio playback, so that clients / players have time to act.
			setTimeout(this._postProcessing, Math.max(tBuffer, 2) * 1000 - 500, now);
		}

		if (this.cache.length > consts.CACHE_MAX_LEN) this.cache.pop();
	}

	_final(next) { // only in file mode, because radio streams "never" end
		log.info('flushing post processor cache');
		for (let i=3; i>=1; i--) {
			this._postProcessing(this.cache[i].ts);
		}
		next();
	}

	_postProcessing(tsRef) {
		if (this.ended) return log.warn('abort _postProcessing event because stream is ended.');

		const i = this.cache.map(e => e.ts).indexOf(tsRef);
		if (i < 0) return log.warn("_postProcessing: cache item not found for tsRef=" + tsRef);

		const availableSlotsFuture = Math.min(i, 4); // consts.MOV_AVG_WEIGHTS supports up to 4 slots in the future.
		const availableSlotsPast = Math.min(this.cache.length - 1 - i, consts.MOV_AVG_WEIGHTS[0].weights.length - availableSlotsFuture - 1); // verification: first slot ever (i=0, cache.len=1) leads to zero past slots.

		/*if (availableSlotsFuture + availableSlotsPast < 10) {
			return log.warn("_postProcessing: i=" + i + " n=" + this.cache[i].n + " not enough cache. future=" + availableSlotsFuture + " past=" + availableSlotsPast);
		}*/

		// smoothing over time of ML predictions.
		let mlOutput = null;
		if (this.cache[i].ml) {
			let movAvg = new Array(3);
			let iMaxMovAvg = 0;
			let maxMovAvg = 0;
			for (let ic = 0; ic < movAvg.length; ic++) {
				movAvg[ic] = 0;
				let sum = 0;
				for (let j = 0; j <= availableSlotsPast + availableSlotsFuture; j++) {
					//if (ic == 0) log.debug("i=" + i + " cacheLen=" + this.cache.length + " availPast=" + availableSlotsPast + " availFut=" + availableSlotsFuture + " j=" + j + " ml?=" + !!(this.cache[i + availableSlotsPast - j].ml));
					if (this.cache[i + availableSlotsPast - j].ml && this.cache[i + availableSlotsPast - j].ml.softmaxs) {
						if (ic == 0 && isNaN(this.cache[i + availableSlotsPast - j].ml.softmaxs[ic])) log.warn("this.cache[i + availableSlotsPast - j].ml.softmaxs[ic] is NaN. i=" + i + " availableSlotsPast=" + availableSlotsPast + " j=" + j + " ic=" + ic);
						if (ic == 0 && isNaN(consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j])) log.warn("consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j] is NaN. availableSlotsFuture=" + availableSlotsFuture + " j=" + j);
						movAvg[ic] += this.cache[i + availableSlotsPast - j].ml.softmaxs[ic] * consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j];
						sum += consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j];
					}
				}
				movAvg[ic] = sum ? (movAvg[ic] / sum) : null;
				if (movAvg[ic] && movAvg[ic] > maxMovAvg) {
					maxMovAvg = movAvg[ic];
					iMaxMovAvg = ic;
				}
			}

			// pruning of unsure ML predictions
			// confidence = 1.0-math.exp(1-mp[2]/mp[1])
			const mlConfident = maxMovAvg > 0.65;
			//log.debug("out: movAvg: slot n=" + this.cache[i].n + " i=" + i + " movAvg=" + movAvg.map(e => +e.toFixed(3)) + " confident=" + mlConfident);
			mlOutput = {
				class: mlConfident ? consts.WLARRAY[iMaxMovAvg] : consts.UNSURE,
				softmaxraw: this.cache[i].ml && this.cache[i].ml.softmaxs.map(e => +e.toFixed(3)),
				softmax: movAvg.map(e => +e.toFixed(3)),
				slotsFuture: availableSlotsFuture,
				slotsPast: availableSlotsPast
			}
		}

		// pruning of unclear hotlist detections
		let hotlistOutput = null;
		if (this.cache[i].hotlist) {
			const hlConfident = this.cache[i].hotlist.matchesTotal >= 20 &&
				this.cache[i].hotlist.matchesSync / this.cache[i].hotlist.matchesTotal > 0.2;
			hotlistOutput = {
				class: hlConfident ? consts.WLARRAY[this.cache[i].hotlist.class] : consts.UNSURE,
				file: hlConfident ? this.cache[i].hotlist.file : null,
				matches: this.cache[i].hotlist.matchesSync,
				total: this.cache[i].hotlist.matchesTotal,
			}
		}

		// synthesis of predictions. hotlist, when available, is always right. machine learning otherwise.
		let finalClass;
		if (hotlistOutput && hotlistOutput.class !== consts.UNSURE) {
			finalClass = hotlistOutput.class;
		} else if (mlOutput && mlOutput.class !== consts.UNSURE) {
			finalClass = mlOutput.class;
		} else {
			finalClass = consts.UNSURE;
		}

		// final output
		let out = {
			gain: this.cache[i].gain && +this.cache[i].gain.toFixed(2),
			ml: mlOutput,
			hotlist: hotlistOutput,
			class: finalClass,
			metadataPath: this.cache[i].metadataPath,
		}

		if (this.config.fileMode) {
			Object.assign(out, { // results specific to file analysis mode
				tStart: this.cache[i].tStart,
				tEnd: this.cache[i].tEnd,
			});
		} else {
			//log.debug("streamInfo=" + JSON.stringify(this.streamInfo, null, "\t"));
			Object.assign(out, { // results specific to stream analysis mode
				audio: this.cache[i].audio,
				predictorStartTime: this.startTime,
				metadata: +new Date() < this.metadataValidUntil ? this.metadata : null,
				streamInfo: this.streamInfo,
				playTime: Math.round(tsRef + this.cache[i].tBuf * 1000),
				tBuffer: +this.cache[i].tBuf.toFixed(2),
			});
		}

		//log.debug(JSON.stringify(Object.assign(out, { audio: undefined }), null, "\t"));

		this.push(out);
	}
}


class Analyser extends Readable {
	constructor(options) {
		super({ objectMode: true });

		this.country = options.country;
		this.name = options.name;

		if (!this.country || !this.name) {
			return log.error("Analyser needs to be constructed with: country (string) and name (string)");
		}

		// default module options
		this.config = {
			saveMetadata: true, // save a JSON with predictions (saveDuration intervals)
			verbose: false,
			file: null, // analyse a file instead of a HTTP stream
		}

		// optional custom config
		Object.assign(this.config, options.config);

		this.postProcessor = new PostProcessor({
			verbose: this.config.verbose,
			fileMode: !!this.config.file,
		});

		const self = this;
		this.postProcessor.on("data", function(obj) {
			if (!self.config.file && !obj.audio) {
				log.warn("empty audio! " + JSON.stringify(obj));
			}

			const metadataPath = obj.metadataPath;
			Object.assign(obj, {
				audioLen: obj.audio ? obj.audio.length : undefined,
				metadataPath: undefined
			});

			self.push({ liveResult: obj });

			if (!self.config.saveMetadata) return;
			if (!metadataPath) {
				log.warn("did not save metadata file, because missing metadataPath parameter");
			} else if (self.config.file) {
				self.data = self.data || { predictions: [], country: self.country, name: self.name };
				self.data.predictions.push(obj);
			} else {
				self.saveMetadata(obj, metadataPath);
			}
		});

		this.postProcessor.on("end", function() {
			log.info("postProcessor ended");
			if (!self.data) return self.push(null);
			self.mergeClassBlocks(self.data, function(blocksCleaned) {
				self.push({ blocksCleaned: blocksCleaned });
				self.push(null);
			});
		});

		if (this.config.file) {
			if (fs.existsSync(this.config.file + ".json")) fs.unlinkSync(this.config.file + ".json");
			this.predictor = new PredictorFile({
				country: self.country,
				name: self.name,
				file: this.config.file,
				config: options.config,
				listener: this.postProcessor
			});
		} else {
			this.predictor = new Predictor({
				country: self.country,
				name: self.name,
				config: options.config,
				listener: this.postProcessor
			});
		}

		/*
		// only to test mergeClassBlocks method
		fs.readFile(this.config.file + ".json", function(err, data) {
			data = JSON.parse(data);
			self.mergeClassBlocks(data, function(blocksCleaned) {
				self.push(blocksCleaned);
				self.push(null); // end the Analyser Readable stream
			});
		});
		*/
	}

	saveMetadata(obj, path) {
		const self = this;
		fs.readFile(path, function(err, readData) {
			let data = { predictions: [] };

			if (!err) {
				try {
					data = JSON.parse(readData);
				} catch (e) {
					log.warn("metadataPath read parsing err=" + JSON.stringify(e));
				}
			} else if (err && err.code !== "ENOENT") {
				log.debug("metadataPath read err=" + JSON.stringify(err) + ". erase any previous metadata info");
			}
			let outputData = Object.assign({}, obj);

			// extract redundant info: no need to repeat it in predictions array
			// if the title metadata changes, only the last one is saved
			data.metadata = outputData.metadata;
			data.streamInfo = outputData.streamInfo;
			data.predictorStartTime = outputData.predictorStartTime;
			data.country = self.country;
			data.name = self.name;

			Object.assign(outputData, {
				audio: undefined,
				metadata: undefined,
				streamInfo: undefined,
				predictorStartTime: undefined
			});

			data.predictions.push(outputData);

			fs.writeFile(path, JSON.stringify(data, null, "\t"), function(err) {
				if (err) log.warn("metadata write err=" + JSON.stringify(err));
			});
		});
	}

	mergeClassBlocks(data, callback) {
		//const self = this;
		const path = this.config.file + ".json";

		data.blocksRaw = [];
		for (let i=0; i<data.predictions.length; i++) {
			const ml = data.blocksRaw.length
			if (!ml || data.blocksRaw[ml-1].class !== data.predictions[i].class) {
				data.blocksRaw.push({
					class: data.predictions[i].class,
					tStart: data.predictions[i].tStart,
					tEnd: data.predictions[i].tEnd
				});
			} else { // same class as the previous one.
				data.blocksRaw[ml-1].tEnd = data.predictions[i].tEnd;
			}
		}


		// convert short blocks to "unsure" and merge any sequential "unsure" blocks together
		data.blocksCoarse = data.blocksRaw.slice().map(b => Object.assign({}, b));
		for (let i=data.blocksCoarse.length-1; i>=0; i--) {
			//const l = data.blocksCoarse.length;
			const delta = data.blocksCoarse[i].tEnd - data.blocksCoarse[i].tStart;
			if (delta < 5000) {
				data.blocksCoarse[i].class = "unsure";
			}
		}
		for (let i=data.blocksCoarse.length-1; i>=1; i--) {
			if (data.blocksCoarse[i-1].class === "unsure" && data.blocksCoarse[i].class === "unsure") {
				data.blocksCoarse[i-1].tEnd = data.blocksCoarse[i].tEnd;
				data.blocksCoarse.splice(i, 1);
			}
		}


		// remove unsure blocks, assume neighbors are right.
		data.blocksCleaned = data.blocksCoarse.slice().map(b => Object.assign({}, b));
		if (data.blocksCleaned.length >= 2 && data.blocksCleaned[0].class === "unsure") { // remove first if unsure
			data.blocksCleaned[1].tStart = data.blocksCleaned[0].tStart;
			data.blocksCleaned.splice(0, 1);
		}
		if (data.blocksCleaned.length >= 2 && data.blocksCleaned[data.blocksCleaned.length-1].class === "unsure") { // remove last if unsure
			data.blocksCleaned[data.blocksCleaned.length-2].tEnd = data.blocksCleaned[data.blocksCleaned.length-1].tEnd;
			data.blocksCleaned.splice(data.blocksCleaned.length-1, 1);
		}
		for (let i=data.blocksCleaned.length-2; i>=1; i--) { // remove others if unsure
			if (data.blocksCleaned[i].class !== "unsure") continue;
			if (data.blocksCleaned[i+1].class !== data.blocksCleaned[i-1].class) { // unsure between two different blocks
				const delta = data.blocksCleaned[i].tEnd - data.blocksCleaned[i].tStart;
				data.blocksCleaned[i+1].tStart -= delta / 2;
				data.blocksCleaned[i-1].tEnd += delta / 2;
				data.blocksCleaned.splice(i, 1);
			} else { // unsure between two identical blocks. remove it
				data.blocksCleaned[i-1].tEnd = data.blocksCleaned[i+1].tEnd;
				data.blocksCleaned.splice(i, 2);
			}
		}

		fs.writeFile(path, JSON.stringify(data, null, "\t"), function(err) {
			if (err) log.warn("metadata write err=" + JSON.stringify(err));
			log.info("detailed analysis results have been written to " + path);
			callback(data.blocksCleaned);
		});
	}

	refreshPredictorMl() {
		this.predictor.refreshPredictorMl();
	}

	refreshPredictorHotlist() {
		this.predictor.refreshPredictorHotlist();
	}

	stopDl() {
		// TODO
		this.predictor.stop();
		this.postProcessor.ended = true;
		this.postProcessor.end();
	}

	_read() {
		// nothing
	}
}

exports.PostProcessor = PostProcessor
exports.Analyser = Analyser;