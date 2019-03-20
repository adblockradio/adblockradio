// MFCC module
//
// Aims at reproducing the python_speech_features.mfcc() function
// https://github.com/jameslyons/python_speech_features

"use strict";
const dsp = require('dsp.js');
const mfcc = require('mfcc');
const { log } = require("abr-log")("pred-ml/mfcc");

const DEBUG = false;

module.exports = function(SAMPLING_RATE, MFCC_WINLEN, MFCC_WINSTEP, WANT_VERBOSE_RESULTS) {

	const PREEMPHASIS_FACTOR = 0.97; // 0 = no preemphasis
	const MFCC_NFFT = 2048;
	const FFT = new dsp.FFT(MFCC_NFFT, SAMPLING_RATE);
	const MFCC_NFILT = 26; // number of filter banks in MFCC
	const MFCC_NCEPS = 13; // number of cepstral coefficients to output. warning: this is also hardcoded in 'mfcc' module
	const MFCC_LIFT = 22; // lifting coefficient for computed MFCC
	const MFCC = mfcc.construct(MFCC_NFFT / 2, MFCC_NFILT, 0, SAMPLING_RATE / 2, SAMPLING_RATE);

	const winlen = Math.ceil(MFCC_WINLEN * SAMPLING_RATE);
	const winstep = Math.ceil(MFCC_WINSTEP * SAMPLING_RATE);

	return function(workingBuf) {

		const nWorkingSamples = workingBuf.length / 2;
		if (workingBuf.length % 2) {
			throw new Error('Signal has an odd number of bytes. Are you sure it\'s 16 bit audio?');
		}

		// pre-emphasis
		const filtered = new Array(nWorkingSamples);
		filtered[0] = workingBuf.readInt16LE(0); // - PREEMPHASIS_FACTOR * ;
		for (let i=1; i<nWorkingSamples; i++) {
			filtered[i] = workingBuf.readInt16LE(2*i) - PREEMPHASIS_FACTOR * workingBuf.readInt16LE(2*(i-1));
		}

		// divide the signal in chunks and analyse each chunk. If the last chunk is not filled with data, pad with zeros.
		const nWin = 1 + Math.ceil((nWorkingSamples - winlen) / winstep);
		if (DEBUG) log.debug(nWorkingSamples + " samples ready to be converted to in " + nWin + " series of " + MFCC_NCEPS + " MFCC");
		const ceps = new Array(nWin);

		if (WANT_VERBOSE_RESULTS) {
			var verboseResults = {
				preemph: filtered.slice(0, 100),
				nWin: nWin,
				frames: [],
				feat: [],
				energy: [],
				dct: [],
			}
		}
		//console.log("nwin=" + nWin);
		for (let i=0; i<nWin; i++) {
			//const t0 = new Date();
			let data = filtered.slice(i*winstep, i*winstep + winlen);
			if (data.length < winlen) {
				if (DEBUG) log.debug("pad window " + i + " with " + (winlen - data.length) + " zeroes");
				data = data.concat(new Array(winlen - data.length).fill(0));
			}

			if (data.length < MFCC_NFFT) { // pad with zeros. It's OK to fill with zeros as long as there is more data than zeros
				const nZeros = MFCC_NFFT - data.length;
				data = data.concat(new Array(nZeros).fill(0));
				if (DEBUG) log.debug("fill with " + nZeros + " zeros");
			}
			//const t1 = new Date();
			FFT.forward(data); // compute FFT in-place
			//const t2 = new Date();

			// convert a Float64Array spectrum to a power spectrum list
			const halfPowerSpectrum = [].slice.call(FFT.spectrum).map(e => Math.pow(e, 2) * MFCC_NFFT / 4);

			// approximation: to map as closely as possible what python_speech_features does,
			// we add a term close to the contribution at the Nyquist frequency.
			halfPowerSpectrum.push(halfPowerSpectrum[halfPowerSpectrum.length - 1]);
			// now halfPowerSpectrum's length is NFFT/2 + 1.

			const energy = halfPowerSpectrum.reduce((acc, val) => acc + val);
			//const t3 = new Date();
			const mfccData = MFCC(halfPowerSpectrum.slice(0, -1), true);
			//const t4 = new Date();

			// cepstra lifter (boost higher frequencies)
			for (let j=0; j<mfccData.melCoef.length; j++) {
				mfccData.melCoef[j] *= 1 + (MFCC_LIFT/2) * Math.sin(Math.PI * (j+1) / MFCC_LIFT);
			}

			// replace first cepstral coefficient with log of frame energy
			ceps[i] = [Math.log(energy)].concat(mfccData.melCoef);
			if (i === 0) {
				if (DEBUG) log.debug("ceps[0] nceps " + ceps[0].length);
			}

			if (WANT_VERBOSE_RESULTS) {
				if (i < 10) verboseResults.frames.push(data);
				if (i === 0) verboseResults.powspec = halfPowerSpectrum;
				verboseResults.feat.push(mfccData.melSpec);
				verboseResults.energy.push(energy);
				verboseResults.bins = mfccData.bins;
				verboseResults.filters = mfccData.filters;
				verboseResults.ceps = ceps;
				verboseResults.dct.push(require('dct')(mfccData.melSpecLog).slice(0,13).map(function(c, index) {
					const norm = 1 / Math.sqrt(2*mfccData.melSpecLog.length);
					if (index === 0) return c * norm / Math.sqrt(2);
					return c * norm;
				}));
			}
			//const t5 = new Date();
			//console.log("t01=" + (+t1-t0) + " t12=" + (+t2-t1) + " t23=" + (+t3-t2) + " t34=" + (+t4-t3) + " t45=" + (+t5-t4) + " total=" + (+t5-t0));
		}

		// now ceps is an array of nWin frames of MFCC_NCEPS values.
		if (DEBUG) log.debug("ceps 2D array dim=" + nWin + "x" + ceps[0].length);

		if (WANT_VERBOSE_RESULTS) {
			return verboseResults;
		} else {
			return ceps;
		}
	}
}