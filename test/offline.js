"use strict";

const { log } = require("abr-log")("test-offline");
const { Analyser } = require("../post-processing.js");
const fs = require("fs-extra");
const assert = require("assert");
const cluster = require("cluster");

const PRED_INTERVAL = 1; // in seconds
const COUNTRY = "France";
const NAME = "RTL";

const MLJS = process.argv.includes('--mljs');

if (cluster.isMaster) {

	// first, download some chunks of audio
	// then analyse it afterwards.

	const streamDownload = function(callback) {

		const CLOSE_DELAY = 5000; // time to download
		const TIMEOUT = 30000; // ms, counted in addition to CLOSE_DELAY

		let cp = null;
		let dlGotData = false;
		let dlStopped = false;
		let dlFinished = false;
		let dlHasErrors = false;
		let dlExited = false;
		let dlExitCode = null;
		let dlTimeout = null;
		let dlTimedOut = false;

		let metaFiles = [];
		let metaFilesContent = null;
		let metaFilesSane = null;
		let audioExt = null;
		let nPredictions = null;

		setTimeout(function() {
			log.info('stop the stream analysis');
			cp.send({ action: 'stop' });
			dlStopped = true;

			dlTimeout = setTimeout(async function() {
				log.warn('child process has not exited properly. kill it.');
				cp.kill();
				dlTimedOut = true;
				await read();
				callback(metaFiles, audioExt, nPredictions, test);
			}, TIMEOUT)

		}, CLOSE_DELAY);


		cp = cluster.fork({
			step: 'dl',
		});

		cp.on('message', function(msg) {
			if (msg.data) {
				dlGotData = true;
				if (msg.data.liveResult && msg.data.liveResult.streamInfo) {
					audioExt = msg.data.liveResult.streamInfo.audioExt;
				}
				if (msg.data.metadataPath) {
					log.debug("metafile=" + msg.data.metadataPath);
					if (!metaFiles.includes(msg.data.metadataPath)) metaFiles.push(msg.data.metadataPath);
				}
			} else if (msg.type === 'end') {
				dlFinished = true;
			}
		});

		cp.on('error', function(err) {
			log.error('child process had an error: ' + err);
			dlHasErrors = true;
		});

		cp.on('exit', async function(code) {
			dlExited = true;
			dlExitCode = code;
			if (dlTimeout) clearTimeout(dlTimeout);
			await read();
			callback(metaFiles, audioExt, nPredictions, test);
		});

		const read = async function() {
			metaFilesContent = new Array(metaFiles.length);
			metaFilesSane = new Array(metaFiles.length);
			nPredictions = new Array(metaFiles.length);

			for (let i=0; i<metaFiles.length; i++) {
				try {
					metaFilesContent[i] = JSON.parse(await fs.readFile(metaFiles[i]));
					//console.log(metaFilesContent[i]);
					nPredictions[i] = metaFilesContent[i].predictions.length;
					metaFilesSane[i] = true;
				} catch (e) {
					log.error("Could not read back " + metaFiles[i]);
				}
			}
		}

		const test = function() {
			describe('Stream download', function() {

				it("should have emitted data", function() {
					assert(dlGotData);
					assert(metaFiles.length);
					assert(audioExt);
				});

				it("should have emitted an end event", function() {
					assert(dlFinished);
				});

				it("should not have thrown errors", function() {
					assert(!dlHasErrors);
				});

				it("should have exited properly", function() {
					assert(dlStopped);
					assert(dlExited);
					assert.equal(dlExitCode, 0);
					assert(!dlTimedOut);
				});

				it("should have written proper JSON files", function() {
					for (let i=0; i<metaFilesContent.length; i++) {
						assert(metaFilesSane[i]);
						const c = metaFilesContent[i];
						assert(c.predictions);
						assert(!isNaN(c.predictorStartTime));
						assert(c.country);
						assert(c.name);
					}
				});
			});
		};
	}


	const offlineAnalysis = function(metaFiles, records, callback) {
		const TIMEOUT = 10000; // ms, counted in addition to CLOSE_DELAY
		let cp = null;

		let oaHasErrors = false;
		let oaFinished = false;
		let oaExited = false;
		let oaExitCode = null;
		let oaTimedOut = false;

		let metaFilesContent = null;
		let metaFilesSane = null;
		let nPredictions = null;

		const oaTimeout = setTimeout(async function() {
			log.warn('child process has not exited properly. kill it.');
			cp.kill();
			oaTimedOut = true;
			await read();
			callback(test);
		}, TIMEOUT)


		cp = cluster.fork({
			step: 'analyse',
			records: JSON.stringify(records),
		});

		cp.on('message', function(msg) {
			if (msg.type === 'end') {
				oaFinished = true;
			}
		});

		cp.on('error', function(err) {
			log.error('child process had an error: ' + err);
			oaHasErrors = true;
		});

		cp.on('exit', async function(code) {
			if (oaTimedOut) return;
			oaExited = true;
			oaExitCode = code;
			if (oaTimeout) clearTimeout(oaTimeout);
			await read();
			callback(test);
		});

		const read = async function() {
			metaFilesContent = new Array(metaFiles.length);
			metaFilesSane = new Array(metaFiles.length);
			nPredictions = new Array(metaFiles.length);

			for (let i=0; i<metaFiles.length; i++) {
				try {
					metaFilesContent[i] = JSON.parse(await fs.readFile(metaFiles[i]));
					//console.log(metaFilesContent[i]);
					nPredictions[i] = metaFilesContent[i].predictions.length;
					metaFilesSane[i] = true;
				} catch (e) {
					log.error("Could not read back " + metaFiles[i]);
				}
			}
		}

		const test = function() {
			describe('Offline analysis (' + (MLJS ? 'JS' : 'Python') + ' child process)', function() {

				it("should have emitted an end event", function() {
					assert(oaFinished);
				});

				it("should not have thrown errors", function() {
					assert(!oaHasErrors);
				});

				it("should have exited properly", function() {
					assert(oaExited);
					assert.equal(oaExitCode, 0);
					assert(!oaTimedOut);
				});

				it("should have filled the prediction slots", function() {

					for (let i=0; i<metaFilesContent.length; i++) {
						assert(metaFilesSane[i]);
						//assert.equal(nPredictions[i], origNPredictions[i]);

						const c = metaFilesContent[i];
						assert(c.predictions);
						assert(!isNaN(c.predictorStartTime));
						assert(c.country);
						assert(c.name);

						for (let j=0; j<c.predictions.length; j++) {
							const p = c.predictions[i];

							// coarse testing of ml and hotlist results
							assert(p.gain);
							assert(p.ml);
							assert(p.ml.class);

							assert(p.hotlist);
							assert(p.hotlist.class);
						}
					}
				})
			});
		};
	}

	streamDownload(function(metaFiles, audioExt, nPredictions, dlTestFunction) {
		dlTestFunction();

		const records = metaFiles
			.map(path => path.replace(".json", "." + audioExt));

		log.info("records to analyse (" + records.length + "): ");
		log.info(records);

		offlineAnalysis(metaFiles, records, function(oaTestFunction) {
			oaTestFunction(nPredictions);
			run();
		});
	});

} else {

	if (process.env.step === 'dl') {

		//const wtf = require("wtfnode");

		const abr = new Analyser({
			country: COUNTRY,
			name: NAME,
			config: {
				predInterval: PRED_INTERVAL,
				saveDuration: 10 / PRED_INTERVAL,
				enablePredictorHotlist: false,
				enablePredictorMl: false,
				saveAudio: true,
				saveMetadata: true,
				fetchMetadata: true,
				verbose: true,
				JSPredictorMl: MLJS,
			}
		});

		abr.on("data", function(obj) {
			obj.liveResult.audio = "[redacted]";
			//log.info(obj.metadataPath);
			//log.info(JSON.stringify(obj.liveResult, null, "\t"));
			process.send({ type: 'data', data: obj });
		});

		abr.on("close", function() {
			process.send({ type: 'end' });
			log.info("analyser ended");
			process.disconnect(); // otherwise the IPC prevents the subprocess from gracefully exiting
		});

		process.on('message', function(msg) {
			if (msg && msg.action === 'stop') {
				abr.stopDl();
			}
		});

		//setInterval(wtf.dump, 1000);


	} else if (process.env.step === 'analyse') {
		//const wtf = require("wtfnode");
		const abr = new Analyser({
			country: COUNTRY,
			name: NAME,
			config: {
				records: JSON.parse(process.env.records),
				predInterval: PRED_INTERVAL,
				saveDuration: 10 / PRED_INTERVAL,
				enablePredictorHotlist: true,
				enablePredictorMl: true,
				modelUpdates: false,
				JSPredictorMl: MLJS,
			}
		});

		abr.on("close", function() {
			log.info("predictor closed");
			process.send({ type: 'end' });
			process.disconnect(); // otherwise the IPC prevents the subprocess from gracefully exiting
		});

		//setInterval(wtf.dump, 2000);

	} else {
		log.error("wrong environment variable 'step': " + process.env.step);
		process.disconnect();
	}


}
