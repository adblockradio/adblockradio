const { log } = require("abr-log")("test-file");
const { Analyser } = require("../post-processing.js");
const fs = require("fs-extra");
const assert = require("assert");
const cluster = require("cluster");

const FILE = __dirname + '/file.mp3';
const TEST_ML = true;
const TEST_HOTLIST = true;
const PRED_INTERVAL = 1; // in seconds

const MLJS = process.argv.includes('--mljs');

if (cluster.isMaster) {

	const TIMEOUT = 60000; // this must be at least the length of the audio tested

	let cp = null;
	let gotData = false;
	let gotBlocks = false;
	let finished = false;
	let hasErrors = false;
	let exited = false;
	let exitCode = null;
	let timedOut = false;
	let fileOutput = {};
	let fileOutputIsSane = false;
	let refreshCorrectlyHandled = false;
	let refreshError = false;

	const timer = setTimeout(function() {
		log.error('analysis timed out or was too slow. kill it.');
		timedOut = true;
		cp.kill();
		run();
	}, TIMEOUT);

	fs.unlink(FILE + '.json', function(err) {
		// we ignore err here.
		cp = cluster.fork();
		cp.on('message', function(msg) {
			if (msg.type === 'data') {
				if (msg.data) {
					gotData = true;
				}
				if (msg.data.blocksCleaned) {
					gotBlocks = true;
				}
			} else if (msg.type === 'refresh') {
				if (msg.hasError) {
					refreshError = true;
				}
				refreshCorrectlyHandled = msg.result === false;

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
			clearTimeout(timer);

			fs.readFile(FILE + '.json', function(err, data) {
				try {
					fileOutput = JSON.parse(data);
					fileOutputIsSane = true;
				} catch (e) {
					fileOutputIsSane = false;
				}
				run();
			});
		});
	});

	// for debug purposes. test the previous results directly, without redoing the computations
	// if you want to do so, comment out the code above
	/*fs.readFile(FILE + '.json', function(err, data) {
		fileOutputIsSane = true;
		fileOutput = JSON.parse(data);
		run();
	});*/

	describe('File analysis (' + (MLJS ? 'JS' : 'Python') + ' child process)', function() {

		it("should have emitted data", function() {
			assert(gotData);
			assert(gotBlocks);
		});

		it("should have reached the end of the file", function() {
			assert(finished);
		});

		it("should reject attempts to reload ML model, hotlist DB or metadata scraper during analysis.", function() {
			assert.equal(refreshError, false);
			assert(refreshCorrectlyHandled);
		});

		it("should not have thrown errors", function() {
			assert(!hasErrors);
		});

		it("should have exited properly", function() {
			assert(exited);
			assert.equal(exitCode, 0);
			assert(!timedOut);
		});

		it("should write results in JSON format", function() {
			assert(fileOutputIsSane);
			assert(fileOutput.country);
			assert(fileOutput.name);

			const blocks = [fileOutput.blocksRaw, fileOutput.blocksCoarse, fileOutput.blocksCleaned];
			for (let ib = 0; ib<blocks.length; ib++) {
				const block = blocks[ib];
				assert(block.length);
				for (let i=0; i<block.length; i++) {
					assert(!isNaN(block[i].tStart));
					assert(!isNaN(block[i].tEnd));
					assert(['0-ads', '1-speech', '2-music', '3-jingles', '9-unsure'].includes(block[i].class));
				}
			}

			assert(fileOutput.predictions);
			for (let i=0; i<fileOutput.predictions.length; i++) {
				const p = fileOutput.predictions[i];
				assert(p);

				if (TEST_ML) {
					assert(p.gain > 0 && p.gain < 200);
					assert(p.ml);
					assert(['0-ads', '1-speech', '2-music', '9-unsure'].includes(p.ml.class));
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
					assert(['0-ads', '1-speech', '2-music', '3-jingles', '9-unsure'].includes(p.hotlist.class));
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

				assert(['0-ads', '1-speech', '2-music', '3-jingles', '9-unsure'].includes(p.class));
				assert(!isNaN(p.tStart));
				assert(!isNaN(p.tEnd));
				assert(p.tEnd > p.tStart);
				assert(p.tEnd <= p.tStart + PRED_INTERVAL * 1000);
			}
		});
	});

} else {

	const t1 = new Date();

	const abr = new Analyser({
		country: "France",
		name: "RTL",
		config: {
			file: FILE,
			predInterval: PRED_INTERVAL,
			enablePredictorHotlist: TEST_HOTLIST,
			enablePredictorMl: TEST_ML,
			saveMetadata: true,
			verbose: false,
			JSPredictorMl: MLJS
		}
	});

	try {
		const result = abr.refreshPredictorMl() ||
			abr.refreshPredictorHotlist() ||
			abr.refreshMetadata() ||
			abr.stopDl();

		process.send({ type: 'refresh', result, hasError: false });
		log.info('refresh attempted. result=' + result);
	} catch (e) {
		log.error('refresh attempt error: ' + e);
		process.send({ type: 'refresh', hasError: true });
	}

	abr.on("data", function(obj) {
		//log.info(JSON.stringify(obj, null, "\t"));
		process.send({ type: 'data', data: obj });
	});

	abr.on("close", function() {
		const t2 = new Date();
		log.info("finished analysing file " + FILE + " in " + (+t2-t1)/1000 + " seconds");
		process.send({ type: 'end' });
		process.disconnect(); // otherwise the IPC prevents the subprocess from gracefully exiting
	});
}
