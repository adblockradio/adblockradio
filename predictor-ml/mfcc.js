// MFCC module
//
// Aims at reproducing the python_speech_features.mfcc() function
// https://github.com/jameslyons/python_speech_features

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
	const MFCC = mfcc.construct(MFCC_NFFT, MFCC_NFILT, 1e-8, SAMPLING_RATE / 2, SAMPLING_RATE);

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
		const nWin = Math.ceil((nWorkingSamples - MFCC_WINLEN * SAMPLING_RATE) / (MFCC_WINSTEP * SAMPLING_RATE));
		log.debug(nWorkingSamples + " samples ready to be converted to in " + nWin + " series of " + MFCC_NCEPS + " MFCC");
		const ceps = new Array(nWin);

		if (WANT_VERBOSE_RESULTS) {
			var verboseResults = {
				preemph: filtered.slice(0, 100),
				nWin: nWin,
				frames: [],
			}
		}

		for (let i=0; i<nWin; i++) {
			let data = filtered.slice(Math.ceil(SAMPLING_RATE*(i*MFCC_WINSTEP)), Math.ceil(SAMPLING_RATE*(i*MFCC_WINSTEP + MFCC_WINLEN)));

			if (WANT_VERBOSE_RESULTS && i < 10) {
				verboseResults.frames.push(data);
			}

			if (data.length < MFCC_NFFT) { // pad with zeros. It's OK to fill with zeros as long as there is more data than zeros
				const nZeros = MFCC_NFFT - data.length;
				data = data.concat(new Array(nZeros).fill(0));
				if (DEBUG) log.debug("fill with " + nZeros + " zeros");
			}
			//if (DEBUG) log.debug("preemphasized data");
			//if (DEBUG) log.debug(data.map(d => Math.round(d)));
			//if (DEBUG) log.debug(Math.round(data[0]))



			FFT.forward(data); // compute FFT in-place

			/*let energy = 0;
			for (let j=0; j<data.length; j++) { // get the power spectrum
				data[j] = Math.pow(data[j], 2);
				energy += data[j];
			}*/
			if (DEBUG) log.debug("Power spectrum");
			//if (DEBUG) log.debug(FFT.spectrum.map(d => Math.round(d)));
			if (DEBUG) log.debug(Math.round(FFT.spectrum[0]));
			//if (DEBUG) log.debug(FFT.spectrum);

			// convert a Float64Array to list
			const halfPowerSpectrum = [].slice.call(FFT.spectrum);

			// Fourier spectrum of a real signal is symmetrical, i.e. PS[X] = PS[NFFT-1-X]
			// the dsp lib only gives the first NFFT/2 values. We expand the spectrum to have
			// a result of the length MFCC_NFFT.
			const powerSpectrum = halfPowerSpectrum.concat(halfPowerSpectrum.slice().reverse());

			const mfccData = MFCC(powerSpectrum, true);
			ceps[i] = mfccData.power.concat(mfccData.melCoef);
			if (i === 0) {
				log.debug("ceps[0] nceps " + ceps[0].length);
			}

			// replace first cepstral coefficient with log of frame energy
			//ceps[i][0] = Math.log(energy);

			//log.debug("ceps");
			if (DEBUG) log.debug(JSON.stringify(ceps[i]));

			// cepstra lifter (boost higher frequencies)
			for (let j=0; j<MFCC_NCEPS; j++) {
				ceps[i][j] *= 1 + (MFCC_LIFT/2) * Math.sin(Math.PI * j / MFCC_LIFT)
			}

			//log.debug("After lifting:");
			if (DEBUG) log.debug(ceps[i]);
		}

		// now ceps is an array of nWin frames of MFCC_NCEPS values.
		log.debug("ceps 2D array dim=" + nWin + "x" + ceps[0].length);

		if (WANT_VERBOSE_RESULTS) {
			return verboseResults;
		} else {
			return ceps;
		}
	}
}