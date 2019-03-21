// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { log } = require("abr-log")("pred-ml-worker");
//const fs = require("fs");
//global.fetch = require('node-fetch'); // tensorflow-js uses browser API fetch. This is a polyfill for usage in Node
//const tf = require('@tensorflow/tfjs');
const tf = require('@tensorflow/tfjs-node');
const assert = require('assert');

// Input audio sampling rate (Hz). Note audio is assumed to be 16-bit.
const SAMPLING_RATE = 22050;

// Compute each MFCC frame with a window of that length (in seconds)
const MFCC_WINLEN = 0.05;

// How many seconds to step between each MFCC frame
const MFCC_WINSTEP = 0.02;

// Window of audio data sent for each LSTM prediction, in seconds
// Equivalent variable in the Python code: nnXLenT
const LSTM_INTAKE_SECONDS = 4;

// Amount of cepstral coefficients read for each LSTM prediction
// With MFCC_WINSTEP = 0.02 and LSTM_INTAKE_SECONDS = 4, it is equal to 200.
const LSTM_INTAKE_FRAMES = Math.floor(LSTM_INTAKE_SECONDS / MFCC_WINSTEP);

// Compute one LSTM prediction every N seconds.
// It means that you call predict more often than every LSTM_STEP_SECONDS,
// your result will only be made of one LSTM prediction.
// If you call predict on a larger buffer, your result will be the average of several LSTM predictions.
// Equivalent variable in the Python code: nnXStepT
const LSTM_STEP_SECONDS = 0.19*4;

// Amount of cepstral coefficients between each LSTM prediction
// With MFCC_WINSTEP = 0.02 and LSTM_STEP_SECONDS at 0.76, it is equal to 38
// Equivalent variable in the Python code: nnXStep
const LSTM_STEP_FRAMES = Math.round(LSTM_STEP_SECONDS / MFCC_WINSTEP);

const mfcc = require("./mfcc.js")(SAMPLING_RATE, MFCC_WINLEN, MFCC_WINSTEP);

log.info('Child process spawned with the following configuration:');
log.info('modelFile: ' + process.env.modelFile);
assert(process.env.modelFile);

log.info('canonical: ' + process.env.canonical);
assert(process.env.canonical);

let model = null;
let newBuf = null;
let workingBuf = null;
let verbose = false;

function parse(msg) {
	try {
		return JSON.parse(msg);
	} catch (e) {
		log.error(process.env.canonical + ' error parsing msg. msg=' + msg);
		return null;
	}
}

function send(msg) {
	process.send(JSON.stringify(msg));
}

(async function() {
	const handler = tf.io.fileSystem(process.env.modelFile); // see https://stackoverflow.com/a/53766926/5317732
	model = await tf.loadLayersModel(handler);

	// load model from remote file
	//const path = 'https://www.adblockradio.com/models/' + canonical + '/model.json';
	//model = await tf.loadModel(path);
	log.info(process.env.canonical + ': ML model loaded');
	send({ type: 'loading', err: null, loaded: true });
})();

process.on('message', function(msg) {
	msg = parse(msg);
	if (msg.type === 'write') {

		assert(msg.buf);
		assert.equal(msg.buf.type, 'Buffer'); // JSON.stringify represents Buffers as { type: 'Buffer', data: '' }
		newBuf = newBuf ? Buffer.concat([newBuf, Buffer.from(msg.buf.data)]) : Buffer.from(msg.buf.data);
		//log.debug("write " + buf.length / 2 + " samples to the buffer. now " + newBuf.length / 2 + " samples in it");


	} else if (msg.type === 'predict') {

		if (!newBuf) {
			log.warn("empty buffer. skip");
			return send({ type: msg.type, err: 'empty buffer. skip' });
		} else if (!model) {
			log.warn("model is not ready. skip");
			return send({ type: msg.type, err: 'model is not ready. skip' });
		}
		//const t1 = new Date();
		const nSamples = newBuf.length / 2;
		const duration = nSamples / SAMPLING_RATE;
		if (verbose) log.debug("will analyse " + duration + " s (" + nSamples + " samples)");

		// compute RMS for volume normalization
		let s = 0;
		for (let i=0; i<nSamples; i++) {
			s += Math.pow(newBuf.readInt16LE(2*i), 2);
		}
		const rms = isNaN(s) ? 70 : 20 * Math.log10(Math.sqrt(s/nSamples))
		if (verbose) log.debug("segment rms=" + Math.round(rms*100)/100 + " dB");

		// We take the amount of data necessary to generate a new prediction,
		// even if the last prediction was not long ago.
		// It means to save the correct amount of data points to fill an analysis window,
		// then add the new points since the last prediction.
		// Factor 2 comes from the fact that audio is 16 bit.
		// The number of LSTM predictions will depend on LSTM_STEP_SECONDS
		const cropBufLen = 2*Math.floor(LSTM_INTAKE_SECONDS * SAMPLING_RATE) + newBuf.length;
		workingBuf = workingBuf ? Buffer.concat([workingBuf, newBuf]) : newBuf;
		newBuf = null;
		if (workingBuf.length > cropBufLen) {
			if (verbose) log.debug("Working buf will be truncated from " + (workingBuf.length / 2) + " samples to " + cropBufLen);
			workingBuf = workingBuf.slice(-cropBufLen);
			if (verbose) log.debug("working buf new length=" + (workingBuf.length / 2));
		} else if (workingBuf.length <= 2 * MFCC_WINLEN * SAMPLING_RATE) {
			log.warn("Working buffer is too short. Keep it but abort prediction now.");
			return send({ type: msg.type, err: 'Working buffer is too short. Keep it but abort prediction now.' });
		}
		//const t11 = new Date();
		const ceps = mfcc(workingBuf); // call here mfcc.js
		//const t12 = new Date();

		const nWin = ceps.length;
		if (nWin < LSTM_INTAKE_FRAMES) {
			// audio input is shorter than LSTM window
			// left-pad with identical frames
			const nMissingFrames = LSTM_INTAKE_FRAMES - nWin;
			if (verbose) log.warn(nMissingFrames + " frames missing to fit lstm intake")
			const refFrame = ceps[0].slice();
			for (let i=0; i<nMissingFrames; i++) {
				ceps.unshift(refFrame);
			}
		}

		if (verbose) log.debug("ceps.l=" + ceps.length + " intake_frames=" + LSTM_INTAKE_FRAMES + " step_frames=" + LSTM_INTAKE_FRAMES);
		const nLSTMPredictions = Math.floor((ceps.length - LSTM_INTAKE_FRAMES) / LSTM_STEP_FRAMES) + 1;
		if (verbose) log.debug(ceps.length + " frames will be sent to LSTM, in " + nLSTMPredictions + " chunks.");
		const MLInputData = new Array(nLSTMPredictions);

		for (let i=0; i<nLSTMPredictions; i++) {
			MLInputData[i] = ceps.slice(i*LSTM_STEP_FRAMES, i*LSTM_STEP_FRAMES + LSTM_INTAKE_FRAMES);
		}
		//const t2 = new Date();
		const tfResults = model.predict(tf.tensor3d(MLInputData));
		//const t3 = new Date();
		const flatResultsRaw = tfResults.as1D().dataSync();

		// TF.js data is a 1D array. Convert it to a nLSTMPredictions * 3 2D array.
		const resultsRaw = new Array(nLSTMPredictions).fill(0).map(function(__, index) {
			return flatResultsRaw.slice(index*3, (index+1)*3);
		});

		// Average the results across LSTM predictions, to get a 1D array with 3 elements.
		let maxResult = 0;
		let indexMaxResult = -1;
		const resultsAvg = new Array(3).fill(0).map(function(__, index) {
			let sum = 0;
			for (let i=index; i<flatResultsRaw.length; i=i+3) {
				sum += flatResultsRaw[i];
			}
			if (sum > maxResult) {
				maxResult = sum;
				indexMaxResult = index;
			}
			return sum / nLSTMPredictions;
		});

		const secondMaxResult = Math.max(...resultsAvg.slice(0, indexMaxResult).concat(resultsAvg.slice(indexMaxResult + 1)));
		const confidence = 1 - Math.exp(1 - maxResult / nLSTMPredictions / secondMaxResult);
		if (verbose) {
			log.debug("ResultsRaw:");
			console.log(resultsRaw);
			log.debug("ResultsAvg:");
			console.log(resultsAvg);
			log.debug("pred class = " + indexMaxResult + " with softmax = " + maxResult/nLSTMPredictions);
			log.debug("second class is " + secondMaxResult + ". confidence = " + confidence);
		}

		const outData = {
			type: indexMaxResult,
			confidence: confidence,
			softmaxraw: resultsAvg.concat([0]), // the last class is about jingles. ML does not detect them.
			//date: new Date(stream.lastData.getTime() + Math.round(stream.tBuffer*1000)),
			gain: rms,
			lenPcm: workingBuf.length
		};

		send({ type: msg.type, err: null, outData });
		//const t4 = new Date();
		//console.log("Averaged predictions: " + nLSTMPredictions);
		//console.log("pre=" + (+t2-t1) + " ms tf=" + (+t3-t2) + " ms post=" + (+t4-t3) + " ms total=" + (+t4-t1) + " ms");
		//console.log("pre0=" + (+t11-t1) + " pre1=" + (+t12-t11) + " pre2=" + (+t2-t12));
	}
});
