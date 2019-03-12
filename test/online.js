"use strict";

const { log } = require("abr-log")("test-online");
const { Analyser } = require("../post-processing.js");
const fs = require("fs-extra");
const assert = require("assert");
const cluster = require("cluster");

const TEST_ML = true;
const TEST_HOTLIST = true;
const PRED_INTERVAL = 1; // in seconds

if (cluster.isMaster) {

	const CLOSE_DELAY = 15000;
	const TIMEOUT = 10000; // ms counted in addition to CLOSE_DELAY

	let cp = null;
	let gotData = false;
	let finished = false;
	let hasErrors = false;
	let stopped = false;
	let exited = false;
	let exitCode = null;
	let timeout = null;
	let timedOut = false;

	let metaFiles = [];
	let metaFilesContent = null;
	let metaFilesSane = null;

	setTimeout(function() {
		log.info('stop the stream analysis');
		stopped = true;
		cp.send({ action: 'stop' });

		timeout = setTimeout(function() {
			log.warn('child process has not exited properly. kill it.');
			cp.kill();
			timedOut = true;
			run();
		}, TIMEOUT)

	}, CLOSE_DELAY);


	cp = cluster.fork();
	cp.on('message', function(msg) {
		if (msg.type === 'data') {
			if (msg.data) {
				gotData = true;
				if (msg.data.metadataPath) {
					log.debug("metafile=" + msg.data.metadataPath);
					if (!metaFiles.includes(msg.data.metadataPath)) metaFiles.push(msg.data.metadataPath);
				}
			}
		} else if (msg.type === 'stop') {
			stopped = true;
		} else if (msg.type === 'end') {
			finished = true;
		}
	});

	cp.on('error', function(err) {
		log.error('child process had an error: ' + err);
		hasErrors = true;
	});

	cp.on('exit', function(code) {
		exited = true;
		exitCode = code;
		if (timeout) clearTimeout(timeout);

		(async function() {
			metaFilesContent = new Array(metaFiles.length);
			metaFilesSane = new Array(metaFiles.length);

			for (let i=0; i<metaFiles.length; i++) {
				try {
					log.debug("Read " + metaFiles[i]);
					metaFilesContent[i] = await fs.readFile(metaFiles[i]);
					metaFilesContent[i] = JSON.parse(metaFilesContent[i]);
					metaFilesSane[i] = true;
				} catch (e) {
					log.warn("could not read " + metaFiles[i] + " err=" + e);
					metaFilesSane[i] = false;
				}
			}

			run();
		})();
	});

	describe('Live stream analysis', function() {

		it("should have emitted data", function() {
			assert(gotData);
		});

		it("should have emitted an end event", function() {
			assert(finished);
		});

		it("should not have thrown errors", function() {
			assert(!hasErrors);
		});

		it("should have exited properly", function() {
			assert(stopped);
			assert(exited);
			assert.equal(exitCode, 0);
			assert(!timedOut);
		});

		it("should write results in JSON format", function() {
			assert(metaFiles.length);

			for (let i=0; i<metaFiles.length; i++) {
				assert(metaFilesSane[i]);

				const c = metaFilesContent[i];
				assert(c);
				assert(!isNaN(c.predictorStartTime));
				assert(c.country);
				assert(c.name);

				assert(c.streamInfo);
				assert(c.streamInfo.url);

				assert(!isNaN(c.streamInfo.bitrate));
				assert(c.streamInfo.favicon);
				assert(c.streamInfo.homepage);
				assert(c.streamInfo.audioExt);

				assert(c.predictions);

				for (let j=0; j<c.predictions.length; j++) {
					const p = c.predictions[j];

					assert(['0-ads', '1-speech', '2-music', '3-jingles', 'unsure'].includes(p.class));

					assert(p.playTime);
					assert(!isNaN(p.tBuffer));

					// ML module is usually not ready at startup of live stream analysis
					if (TEST_ML && p.ml) {
						assert(p.gain > 60 && p.gain < 85);
						assert(p.ml);
						assert(['0-ads', '1-speech', '2-music'].includes(p.ml.class));
						assert(p.ml.softmaxraw);
						assert.equal(p.ml.softmaxraw.length, 4);
						assert(p.ml.softmax);
						assert.equal(p.ml.softmax.length, 4);
						assert(!isNaN(p.ml.slotsFuture));
						assert(!isNaN(p.ml.slotsPast));
					} else {
						assert.equal(p.ml, null);
					}

					if (TEST_HOTLIST) {
						assert(p.hotlist);
						assert(['0-ads', '1-speech', '2-music', '3-jingles', 'unsure'].includes(p.hotlist.class));
						assert(p.hotlist.softmaxraw);
						assert.equal(p.hotlist.softmaxraw.length, 4);
						assert(p.hotlist.softmax);
						assert.equal(p.hotlist.softmax.length, 4);
						assert(!isNaN(p.hotlist.matchesSync));
						assert(!isNaN(p.hotlist.matchesTotal));
						assert(!isNaN(p.hotlist.confidence1));
						assert(0 <= p.hotlist.confidence1);
						assert(p.hotlist.confidence1 <= 1);
						assert(!isNaN(p.hotlist.confidence2));
						assert(0 <= p.hotlist.confidence2);
						assert(p.hotlist.confidence2 <= 1);
					} else {
						assert.equal(p.hotlist, null);
					}
				}
			}
		});
	});

} else {

	const abr = new Analyser({
		country: 'France',
		name: 'RTL',
		config: {
			predInterval: PRED_INTERVAL,
			saveDuration: 10,
			enablePredictorHotlist: TEST_HOTLIST,
			enablePredictorMl: TEST_ML,
			saveAudio: true,
			saveMetadata: true,
			fetchMetadata: true,
			verbose: false,
		}
	});

	abr.on("data", function(obj) {
		obj.liveResult.audio = "[redacted]";
		//log.info(obj.metadataPath);
		log.info(JSON.stringify(obj.liveResult, null, "\t"));
		process.send({ type: 'data', data: obj });
	});

	abr.on("end", function() {
		process.send({ type: 'end' });
		log.info("analyser ended");
		process.disconnect(); // otherwise the IPC prevents the subprocess from gracefully exiting
	});

	process.on('message', function(msg) {
		if (msg && msg.action === 'stop') {
			abr.stopDl();
		}
	});
}
