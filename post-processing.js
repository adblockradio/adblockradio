// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { log } = require("abr-log")("post-processing");
const PredictorFile = require("./predictor-file.js");
const { Transform, Readable } = require("stream");
const fs = require("fs-extra");
const { checkModelUpdates, checkMetadataUpdates } = require("./check-updates.js");


const consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "3-jingles"],
	UNSURE: "9-unsure",
	CACHE_MAX_LEN: 50,
	MOV_AVG_WEIGHTS: [
		{ "weights": [0.05, 0.05, 0.05, 0.10, 0.10, 0.15, 0.20, 0.30, 0.80, 1.00], "sum": 2.80 }, // r=0 same as ideal r=1 for very short buffers. so 1 step lag
		{ "weights": [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.70, 0.80, 1.00], "sum": 4.30 }, // r=1 same as ideal r=2 for short buffers. so 1 step lag
		{ "weights": [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.70, 0.80, 1.00], "sum": 4.30 }, // r=2
		{ "weights": [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00], "sum": 5.50 }, // r=3
		{ "weights": [0.25, 0.35, 0.50, 0.70, 0.90, 1.00, 1.00, 0.80, 0.70, 0.20], "sum": 6.20 }  // r=4
	],
	ML_CONFIDENCE_THRESHOLD: 0.65,
	HOTLIST_CONFIDENCE_THRESHOLD: 0.5,
	FINAL_CONFIDENCE_THRESHOLD: 0.40,

	WEIGHT_ML: 1,         // in the final softmax computation, weight the contributions
	WEIGHT_HOTLIST: 1.5,  // depending on their origin

	MINIMUM_BUFFER: 2, // in seconds.
	                   // Some radios have a very small buffer, down to zero.
	                   // But browsers such as Firefox and Chrome only start playing after a 2 second buffer.
	                   // So we artificially delay the predictions.
	                   // VLC player, however, plays without such delay.

	DOWNSTREAM_LATENCY: 500, // in milliseconds. broadcast the prediction result N ms before it should be applied by the players of the end users.
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
					this._newCacheSlot(Math.max(obj.tBuffer, consts.MINIMUM_BUFFER));
				}
				this.cache[0].audio = this.cache[0].audio ? Buffer.concat([this.cache[0].audio, obj.data]) : obj.data;
				this.cache[0].metadataPath = obj.metadataPath;
				if (obj.predInterval) this.cache[0].predInterval = obj.predInterval;
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
				if (this.config.verbose) {
					log.info("in: ml => type=" + consts.WLARRAY[obj.data.type] + " confidence=" + obj.data.confidence.toFixed(2) +
						" softmaxraw=" + obj.data.softmaxraw.map(e => e.toFixed(2)) + " confidence=" + obj.data.confidence.toFixed(2));
				}
				if (this.cache[0].ml) log.warn("overwriting ml cache data!")
				this.cache[0].ml = obj.data;
				this.cache[0].gain = obj.data.gain;
				break;

			case "hotlist":
				if (this.config.verbose) {
					log.info("in: hotlist =>" +
						" matches/totR/totM=" + obj.data.matchesSync + "/" + obj.data.fingersCountRef + "/" + obj.data.fingersCountMeasurements +
						" tAvg/tStd/duration=" + obj.data.tRefAvg + "/" + obj.data.tRefStd + "/" + obj.data.durationRef +
						" class=" + consts.WLARRAY[obj.data.class]);
				}
				if (this.cache[0].hotlist) log.warn("overwriting hotlist cache data!");
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
					bitrate: obj.data.bitrate,
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
		this.cache.unshift({ ts: null, audio: null, ml: null, hotlist: null, tBuf: tBuffer, n: this.slotCounter, predInterval: 0, pushed: false });

		if (this.cache[1]) {
			this.cache[1].ts = now;

		} else { // happens only once at startup, when _write is called for the first time
			this.cache[0].ts = now;
		}

		if (this.config.fileMode) {
			// the 5 here is a unit higher than the max number of results in the future taken into
			// account according to consts.MOV_AVG_WEIGHTS and availableSlotsFuture in _postProcessing.
			if (this.cache.length >= 5) {
				this._postProcessing(this.cache[4].ts);
			}

		} else {
			// schedule the postprocessing for this slot, according to the buffer available.
			// "now" is used as a reference for _postProcessing, so it knows which slot to process
			// postProcessing happens 500ms before audio playback, so that clients / players have time to act.
			// Note: a given cache item is broadcast when the next one starts. so the delay between
			// two cache slots (predInterval) is substracted from the available buffer time (tBuffer).

			const predInterval = this.cache[1] ? this.cache[1].predInterval : 0;
			if (this.cache[1] && predInterval === 0) log.warn('zero predInterval!');
			const ppTimeout = setTimeout(this._postProcessing, (tBuffer - predInterval) * 1000 - consts.DOWNSTREAM_LATENCY, now);
			this.cache.find(c => c.ts === now).ppTimeout = ppTimeout;
		}

		if (this.cache.length > consts.CACHE_MAX_LEN) this.cache.pop();
	}

	_final(next) { // only in file mode, because radio streams "never" end
		log.info('flushing post processor cache');
		const cacheToFlush = this.cache.reverse().filter(c => !c.pushed);
		for (let i=0; i<cacheToFlush.length; i++) {
			this._postProcessing(cacheToFlush[i].ts);
			clearTimeout(cacheToFlush[i].ppTimeout);
		}
		next();
	}

	// average the softmax vectors over time, to smooth the results.
	// the average uses a window function in consts.MOV_AVG_WEIGHTS
	//
	// parameters: i: index in this.cache[] being analyzed
	//             prop: either 'ml' or 'hotlist', the softmax to consider
	//             availableSlotsPast: number of time slots to look at in the past
	//             availableSlotsFuture: number of time slots to look at in the future
	_movAvg(i, prop, availableSlotsPast, availableSlotsFuture) {
		let movAvg = new Array(4);
		let iMaxMovAvg = 0;
		let maxMovAvg = 0;
		let localMax = 0;
		let iLocalMax = 0;

		for (let ic = 0; ic < movAvg.length; ic++) {
			movAvg[ic] = 0;
			let sum = 0;
			for (let j = 0; j <= availableSlotsPast + availableSlotsFuture; j++) {
				/*if (ic == 0) {
					log.debug("i=" + i + " cacheLen=" + this.cache.length + " availPast=" + availableSlotsPast +
					" availFut=" + availableSlotsFuture + " j=" + j + " ml?=" + !!(this.cache[i + availableSlotsPast - j].ml));
				}*/
				if (this.cache[i + availableSlotsPast - j][prop] && this.cache[i + availableSlotsPast - j][prop].softmaxraw) {
					if (ic == 0 && isNaN(this.cache[i + availableSlotsPast - j][prop].softmaxraw[ic])) {
						log.warn(this.config.country + "_" + this.config.name + " _movAvg this.cache[i + availableSlotsPast - j]." + prop + ".softmaxraw[ic] is NaN." +
							" i=" + i + " availableSlotsPast=" + availableSlotsPast + " j=" + j + " ic=" + ic);
					}
					if (ic == 0 && isNaN(consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j])) {
						log.warn(this.config.country + "_" + this.config.name + " _movAvg consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j] is NaN." +
							" availableSlotsFuture=" + availableSlotsFuture + " j=" + j);
					}
					movAvg[ic] += this.cache[i + availableSlotsPast - j][prop].softmaxraw[ic] * consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j];
					sum += consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j];
				}
			}
			if (!sum) log.warn(this.config.country + "_" + this.config.name + " _movAvg: sum is zero. i=" + i + " prop=" + prop + " ic=" + ic + " past=" + availableSlotsPast + " future=" + availableSlotsFuture);
			movAvg[ic] = sum ? (movAvg[ic] / sum) : null;
			if (movAvg[ic] && movAvg[ic] > maxMovAvg) {
				maxMovAvg = movAvg[ic];
				iMaxMovAvg = ic;
			}

			if (this.cache[i][prop] && this.cache[i][prop].softmaxraw && this.cache[i][prop].softmaxraw[ic] > localMax) {
				localMax = this.cache[i][prop].softmaxraw[ic];
				iLocalMax = ic;
			}
		}
		//log.debug("movAvg=" + JSON.stringify(movAvg));
		return {
			movAvg: movAvg, // average softmax

			maxMovAvg: maxMovAvg, // max value of the average softmax
			iMaxMovAvg: iMaxMovAvg, // index of that max value

			localMax: localMax, // max value of the softmax at the time considered
			iLocalMax: iLocalMax, // index of that max value
		};
	}

	_postProcessing(tsRef) {
		if (this.ended) return log.warn(this.config.country + "_" + this.config.name + ' abort _postProcessing event because stream is ended.');

		const i = this.cache.map(e => e.ts).indexOf(tsRef);
		if (i < 0) return log.warn(this.config.country + "_" + this.config.name + " _postProcessing: cache item not found for tsRef=" + tsRef);

		const availableSlotsFuture = Math.min(i, 4); // consts.MOV_AVG_WEIGHTS supports up to 4 slots in the future.
		const availableSlotsPast = Math.min(this.cache.length - 1 - i, consts.MOV_AVG_WEIGHTS[0].weights.length - availableSlotsFuture - 1); // verification: first slot ever (i=0, cache.len=1) leads to zero past slots.

		// smoothing over time of ML predictions.
		let mlOutput = null;
		if (this.cache[i].ml) {
			const { movAvg, maxMovAvg, iMaxMovAvg } = this._movAvg(i, "ml", availableSlotsPast, availableSlotsFuture);

			// tell if the ML prediction is unsure. Purely informative, as the threshold does not affect the final class
			const mlConfident = maxMovAvg > consts.ML_CONFIDENCE_THRESHOLD;
			//log.debug("out: movAvg: slot n=" + this.cache[i].n + " i=" + i + " movAvg=" + movAvg.map(e => +e.toFixed(3)) + " confident=" + mlConfident);
			mlOutput = {
				class: mlConfident ? consts.WLARRAY[iMaxMovAvg] : consts.UNSURE,
				softmaxraw: this.cache[i].ml && this.cache[i].ml.softmaxraw.map(e => +e.toFixed(3)),
				softmax: movAvg.map(e => +e.toFixed(3)),
				slotsFuture: availableSlotsFuture,
				slotsPast: availableSlotsPast
			}
		}

		// smoothing over time of hotlist detections
		let hotlistOutput = null;
		if (this.cache[i].hotlist) {
			const { movAvg, maxMovAvg, iMaxMovAvg, localMax, iLocalMax } = this._movAvg(i, "hotlist", availableSlotsPast, availableSlotsFuture);
			hotlistOutput = Object.assign({}, this.cache[i].hotlist);
			hotlistOutput.softmaxraw = hotlistOutput.softmaxraw.map(e => +e.toFixed(3));
			hotlistOutput.softmax = movAvg.map(e => +e.toFixed(3));

			// tell if the hotlist prediction is unsure. Purely informative, as the threshold does not affect the final class
			const hlConfident = maxMovAvg > consts.HOTLIST_CONFIDENCE_THRESHOLD;
			hotlistOutput.class = hlConfident ? consts.WLARRAY[this.cache[i].hotlist.class] : consts.UNSURE;

			// only give the file when it is a local detection. otherwise, could give wrong info
			// if just after a detection, nothing locally detected but movAvg still above threshold.
			const localHlConfident = localMax > consts.HOTLIST_CONFIDENCE_THRESHOLD;
			hotlistOutput.file = localHlConfident ? hotlistOutput.file : null;
		}

		// synthesis of predictions. Average the softmax vectors.
		let finalSoftmax = new Array(4).fill(0);
		let iFinalClass = 0, maxSoftmax = 0;
		for (let i=0; i<4; i++) {
			let count = 0;
			if (mlOutput) {
				finalSoftmax[i] += consts.WEIGHT_ML * mlOutput.softmax[i];
				count += consts.WEIGHT_ML;
			}
			if (hotlistOutput) {
				finalSoftmax[i] += consts.WEIGHT_HOTLIST * hotlistOutput.softmax[i];
				count += consts.WEIGHT_HOTLIST;
			}
			if (count) finalSoftmax[i] /= count;
			if (finalSoftmax[i] > maxSoftmax) {
				maxSoftmax = finalSoftmax[i];
				iFinalClass = i;
			}
		}

		// final class has an hysteresis behaviour
		const finalClass = maxSoftmax > consts.FINAL_CONFIDENCE_THRESHOLD ? consts.WLARRAY[iFinalClass] : consts.UNSURE;

		// final output
		let out = {
			gain: this.cache[i].gain && +this.cache[i].gain.toFixed(2),
			ml: mlOutput,
			hotlist: hotlistOutput,
			class: finalClass,
			softmax: finalSoftmax,
			metadataPath: this.cache[i].metadataPath,
		}

		if (this.config.fileMode) {
			Object.assign(out, { // results specific to file analysis mode
				tStart: this.cache[i].tStart,
				tEnd: this.cache[i].tEnd,
				//playTime: this.config.records ? +new Date(this.cache[i].metadataPath.slice(-24)) : undefined,
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

		try {
			this.push(out);
		} catch (e) {
			log.warn("could not push. err=" + e);
		}
		this.cache[i].pushed = true;
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

		const defaultModelPath = process.cwd() + '/model';
		const defaultHotlistFile = this.country + '_' + this.name + '/hotlist.sqlite';

		// default module options
		this.config = {
			saveMetadata: true,                  // save a JSON with predictions (saveDuration intervals)
			verbose: false,
			file: null,                          // analyse a file instead of a HTTP stream. will not download stream
			records: null,                       // analyse a series of previous records (relative paths). will not download stream
			modelPath: defaultModelPath,         // directory where ML models and hotlist DBs are stored
			hotlistFile: defaultHotlistFile,     // path of the hotlist DB relative to modelPath
			modelUpdates: true,                  // periodically fetch ML and hotlist models and refresh predictors
			modelUpdateInterval: 60,             // update model files every N minutes
			JSPredictorMl: false,                // whether to use JS (+ native lib) instead of Python for ML. JS is simpler but slower.
		}

		// optional custom config
		Object.assign(this.config, options.config);

		const defaultModelFile = this.country + '_' + this.name + '/model.' + (this.config.JSPredictorMl ? 'json' : 'keras');
		if (!this.config.modelFile) this.config.modelFile = defaultModelFile; // path of the ML model relative to modelPath

		this.postProcessor = new PostProcessor({
			country: this.country,
			name: this.name,
			verbose: this.config.verbose,
			fileMode: !!this.config.file || !!this.config.records,
		});

		const self = this;
		this.postProcessor.on("data", function(obj) {
			if (!self.config.file && !self.config.records && !obj.audio) {
				log.warn("empty audio! " + JSON.stringify(obj));
			}

			const metadataPath = obj.metadataPath;
			Object.assign(obj, {
				audioLen: obj.audio ? obj.audio.length : undefined,
				metadataPath: undefined
			});

			(async function() {
				if (self.config.saveMetadata) {
					if (!metadataPath) {
						log.warn("did not save metadata file, because missing metadataPath parameter");
					} else if (self.config.file) {
						self.data = self.data || { predictions: [], country: self.country, name: self.name };
						self.data.predictions.push(obj);
					} else if (self.config.records) {
						self.postProcessor.pause();
						await self.saveMetadata(obj, metadataPath);
						self.postProcessor.resume();
					} else {
						self.postProcessor.pause();
						await self.saveMetadata(obj, metadataPath);
						self.postProcessor.resume()
					}
				}

				self.push({ liveResult: obj, metadataPath: metadataPath });
			})();
		});

		this.postProcessor.on("end", function() {
			log.info("postProcessor ended");
			if (self.config.file) {
				if (!self.data) return self.destroy();
				self.mergeClassBlocks(self.data, function(blocksCleaned) {
					self.push({ blocksCleaned: blocksCleaned });
					self.destroy();
				});
			} else { //if (self.config.records) {
				self.destroy();
			}
		});

		(async function() {

			// download and/or update models at startup
			// TODO only download model/hotlist if ML/hotlist is enabled
			if (self.config.modelUpdates) {
				const files = self.config.JSPredictorMl ?
					[
						{ file: self.config.modelFile, tar: false },
						{ file: self.config.modelFile.replace('model.json', 'group1-shard1of1'), tar: false },
						{ file: self.config.hotlistFile, tar: true },
					]
				:
					[
						{ file: self.config.modelFile, tar: true },
						{ file: self.config.hotlistFile, tar: true },
					]
				;
				await checkModelUpdates({ localPath: self.config.modelPath, files });
			} else {
				log.info(self.country + '_' + self.name + ' model updates are disabled');
			}

			if (self.config.file) {
				// analysis of a single recording
				// suitable for e.g. podcasts.
				// output a file containing time stamps of transitions.
				if (await fs.exists(process.cwd() + "/" + self.config.file + ".json")) await fs.unlink(process.cwd() + "/" + self.config.file + ".json");
				self.predictor = new PredictorFile({
					country: self.country,
					name: self.name,
					file: self.config.file,
					modelFile: self.config.modelPath + '/' + self.config.modelFile,
					hotlistFile: self.config.modelPath + '/' + self.config.hotlistFile,
					config: self.config,
					listener: self.postProcessor
				});

			} else if (self.config.records) {
				// analysis of an array of recordings
				// suitable for asynchronous analysis of chunks of live streams.
				// outputs a complete analysis report for each audio chunk.
				self.offlinets = +new Date();
				self.predictor = new PredictorFile({
					country: self.country,
					name: self.name,
					records: self.config.records,
					modelFile: self.config.modelPath + '/' + self.config.modelFile,
					hotlistFile: self.config.modelPath + '/' + self.config.hotlistFile,
					config: self.config,
					listener: self.postProcessor,
					verbose: true,
				});

			} else {
				// live stream analysis
				// emits results with the Readable interface

				await checkMetadataUpdates();

				// we require only once metadata scraper is downloaded
				// otherwise a previous version could be cached
				const Predictor = require('./predictor.js');

				// download and/or update metadata scraper at startup
				self.predictor = new Predictor({
					country: self.country,
					name: self.name,
					modelFile: self.config.modelPath + '/' + self.config.modelFile,
					hotlistFile: self.config.modelPath + '/' + self.config.hotlistFile,
					config: self.config,
					listener: self.postProcessor
				});

				self.modelUpdatesInterval = setInterval(function() {
					if (self.config.modelUpdates) {
						const files = self.config.JSPredictorMl ?
							[
								{ file: self.config.modelFile, tar: false, callback: self.predictor.refreshPredictorMl },
								{ file: self.config.modelFile.replace('model.json', 'group1-shard1of1'), tar: false, callback: self.predictor.refreshPredictorMl },
								{ file: self.config.hotlistFile, tar: true, callback: self.predictor.refreshPredictorHotlist },
							]
						:
							[
								{ file: self.config.modelFile, tar: true, callback: self.predictor.refreshPredictorMl },
								{ file: self.config.hotlistFile, tar: true, callback: self.predictor.refreshPredictorHotlist },
							]
						;
						checkModelUpdates({ localPath: self.config.modelPath, files });
					}
					checkMetadataUpdates(self.predictor.refreshMetadata);
				}, self.config.modelUpdateInterval * 60000);
			}
		})();

		this.refreshPredictorHotlist = this.refreshPredictorHotlist.bind(this);
		this.refreshPredictorMl = this.refreshPredictorMl.bind(this);
		this.stopDl = this.stopDl.bind(this);

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

	async saveMetadata(obj, path) {
		let data = { predictions: [] };
		try {
			var readData = await fs.readFile(path);//, function(err, readData) {
			data = JSON.parse(readData);
		} catch (e) {
			if (e.code !== "ENOENT") {
				log.debug("path " + path + " read err=" + JSON.stringify(e) + ". erase any previous metadata info");
			} else {
				// the file does not exist, will be created.
			}
		}

		let outputData = Object.assign({}, obj);

		// extract redundant info: no need to repeat it in predictions array
		// if the title metadata changes, only the last one is saved
		data.metadata = outputData.metadata || data.metadata;
		data.streamInfo = outputData.streamInfo || data.streamInfo;
		data.predictorStartTime = outputData.predictorStartTime || data.predictorStartTime;
		data.country = this.country;
		data.name = this.name;

		Object.assign(outputData, {
			audio: undefined,
			metadata: undefined,
			streamInfo: undefined,
			predictorStartTime: undefined
		});

		if (data.offlinets !== this.offlinets && this.config.records) {
			data.predictions = [];
			data.offlinets = this.offlinets;
		}
		data.predictions.push(outputData);

		try {
			await fs.writeFile(path, JSON.stringify(data, null, "\t"));//, function(err) {
		} catch (e) {
			log.warn("path " + path + " write err=" + JSON.stringify(e));
		}
		return;
	}

	// used in the context of file analysis
	// merge contiguous data with identical class to present a more compact result.
	mergeClassBlocks(data, callback) {
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


		// convert short blocks to consts.UNSURE and merge any sequential consts.UNSURE blocks together
		data.blocksCoarse = data.blocksRaw.slice().map(b => Object.assign({}, b));
		for (let i=data.blocksCoarse.length-1; i>=0; i--) {
			//const l = data.blocksCoarse.length;
			const delta = data.blocksCoarse[i].tEnd - data.blocksCoarse[i].tStart;
			if (delta < 5000) {
				data.blocksCoarse[i].class = consts.UNSURE;
			}
		}
		for (let i=data.blocksCoarse.length-1; i>=1; i--) {
			if (data.blocksCoarse[i-1].class === consts.UNSURE && data.blocksCoarse[i].class === consts.UNSURE) {
				data.blocksCoarse[i-1].tEnd = data.blocksCoarse[i].tEnd;
				data.blocksCoarse.splice(i, 1);
			}
		}


		// remove unsure blocks, assume neighbors are right.
		data.blocksCleaned = data.blocksCoarse.slice().map(b => Object.assign({}, b));
		if (data.blocksCleaned.length >= 2 && data.blocksCleaned[0].class === consts.UNSURE) { // remove first if unsure
			data.blocksCleaned[1].tStart = data.blocksCleaned[0].tStart;
			data.blocksCleaned.splice(0, 1);
		}
		if (data.blocksCleaned.length >= 2 && data.blocksCleaned[data.blocksCleaned.length-1].class === consts.UNSURE) { // remove last if unsure
			data.blocksCleaned[data.blocksCleaned.length-2].tEnd = data.blocksCleaned[data.blocksCleaned.length-1].tEnd;
			data.blocksCleaned.splice(data.blocksCleaned.length-1, 1);
		}
		for (let i=data.blocksCleaned.length-2; i>=1; i--) { // remove others if unsure
			if (data.blocksCleaned[i].class !== consts.UNSURE) continue;
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
		if (this.config.file || this.config.records) {
			log.warn("updating ML model is not possible when analysing files. skip.");
			return false;
		}
		this.predictor.refreshPredictorMl();
		return true;
	}

	refreshPredictorHotlist() {
		if (this.config.file || this.config.records) {
			log.warn("updating hotlist DB is not possible when analysing files. skip.");
			return false;
		}
		this.predictor.refreshPredictorHotlist();
		return true;
	}

	refreshMetadata() {
		if (this.config.file || this.config.records) {
			log.warn("updating hotlist DB is not possible when analysing files. skip.");
			return false;
		}
		this.predictor.refreshMetadata();
		return true;
	}

	stopDl() {
		if (this.config.file || this.config.records) {
			log.warn("not possible (yet?) to stop the processing of files. please kill the process instead.");
			return false;
		}
		if (this.modelUpdatesInterval) clearInterval(this.modelUpdatesInterval);
		if (this.predictor) this.predictor.stop();
		return true;
	}

	_read() {
		// nothing
	}
}

exports.PostProcessor = PostProcessor
exports.Analyser = Analyser;