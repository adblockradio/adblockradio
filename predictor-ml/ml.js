// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { Transform } = require("stream");
const { log } = require("abr-log")("pred-ml");
//const fs = require("fs");
//global.fetch = require('node-fetch'); // tensorflow-js uses browser API fetch. This is a polyfill for usage in Node
//const tf = require('@tensorflow/tfjs');
const tf = require('@tensorflow/tfjs-node');

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


class MlPredictor extends Transform {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		this.verbose = options.verbose || false;
		this.ready = false; // becomes true when ML model is loaded
		//this.ready2 = false; // becomes true when audio data is piped to this module. managed externally
		//this.finalCallback = null;
		this.readyToCallFinal = false;
	}

	async load() {
		// TODO: find a way to load model from local file
		// see https://stackoverflow.com/a/53766926/5317732
		const path = 'https://www.adblockradio.com/models/' + this.canonical + '/model.json';
		this.model = await tf.loadModel(path);
		log.info(this.canonical + ' ML model loaded');
		this.ready = true;
	}

	_write(buf, enc, next) {
		this.newBuf = this.newBuf ? Buffer.concat([this.newBuf, buf]) : buf;
		//log.debug("write " + buf.length / 2 + " samples to the buffer. now " + this.newBuf.length / 2 + " samples in it");
		next();
	}

	predict(callback) {
		if (!this.newBuf) {
			log.warn("empty buffer. skip");
			return setImmediate(callback);
		} else if (!this.model) {
			log.warn("model is not ready. skip");
			return setImmediate(callback);
		}

		const nSamples = this.newBuf.length / 2;
		const duration = nSamples / SAMPLING_RATE;
		if (this.verbose) log.debug("will analyse " + duration + " s (" + nSamples + " samples)");

		// compute RMS for volume normalization
		let s = 0;
		for (let i=0; i<nSamples; i++) {
			s += Math.pow(this.newBuf.readInt16LE(2*i), 2);
		}
		const rms = isNaN(s) ? 70 : 20 * Math.log10(Math.sqrt(s/nSamples))
		if (this.verbose) log.debug("segment rms=" + Math.round(rms*100)/100 + " dB");

		// We take the amount of data necessary to generate a new prediction,
		// even if the last prediction was not long ago.
		// It means to save the correct amount of data points to fill an analysis window,
		// then add the new points since the last prediction.
		// Factor 2 comes from the fact that audio is 16 bit.
		// The number of LSTM predictions will depend on LSTM_STEP_SECONDS
		const cropBufLen = 2*Math.floor(LSTM_INTAKE_SECONDS * SAMPLING_RATE) + this.newBuf.length;
		this.workingBuf = this.workingBuf ? Buffer.concat([this.workingBuf, this.newBuf]) : this.newBuf;
		this.newBuf = null;
		if (this.workingBuf.length > cropBufLen) {
			if (this.verbose) log.debug("Working buf will be truncated from " + (this.workingBuf.length / 2) + " samples to " + cropBufLen);
			this.workingBuf = this.workingBuf.slice(-cropBufLen);
			if (this.verbose) log.debug("working buf new length=" + (this.workingBuf.length / 2));
		}

		const ceps = mfcc(this.workingBuf); // call here mfcc.js

		const nWin = ceps.length;
		if (nWin < LSTM_INTAKE_FRAMES) {
			// audio input is shorter than LSTM window
			// left-pad with identical frames
			const nMissingFrames = LSTM_INTAKE_FRAMES - nWin;
			if (this.verbose) log.warn(nMissingFrames + " frames missing to fit lstm intake")
			const refFrame = ceps[0].slice();
			for (let i=0; i<nMissingFrames; i++) {
				ceps.unshift(refFrame);
			}
		}

		if (this.verbose) log.debug("ceps.l=" + ceps.length + " intake_frames=" + LSTM_INTAKE_FRAMES + " step_frames=" + LSTM_INTAKE_FRAMES);
		const nLSTMPredictions = Math.floor((ceps.length - LSTM_INTAKE_FRAMES) / LSTM_STEP_FRAMES) + 1;
		if (this.verbose) log.debug(ceps.length + " frames will be sent to LSTM, in " + nLSTMPredictions + " chunks.");
		const MLInputData = new Array(nLSTMPredictions);

		for (let i=0; i<nLSTMPredictions; i++) {
			MLInputData[i] = ceps.slice(i*LSTM_STEP_FRAMES, i*LSTM_STEP_FRAMES + LSTM_INTAKE_FRAMES);
		}

		const tfResults = this.model.predict(tf.tensor3d(MLInputData));
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
		if (this.verbose) {
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
			lenPcm: this.workingBuf.length
		};

		this.push({ type:"ml", data: outData, array: true });

		setImmediate(function() {
			callback(null, outData);
		});
	}

	_final(next) {
		log.info(this.canonical + " closing ML predictor");

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
		this.readyToCallFinal = next;
	}
}

module.exports = MlPredictor;
