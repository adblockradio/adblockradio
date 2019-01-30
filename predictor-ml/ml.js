// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { Transform } = require("stream");
//const cp = require("child_process");
const { log } = require("abr-log")("pred-ml");
//const zerorpc = require("zerorpc");
//const fs = require("fs");
//global.fetch = require('node-fetch'); // tensorflow-js uses browser API fetch. This is a polyfill for usage in Node
//const tf = require('@tensorflow/tfjs');
const tf = require('@tensorflow/tfjs-node');
const dsp = require('dsp.js');
const mfcc = require('mfcc');

class MlPredictor extends Transform {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		//this.ready = false; // becomes true when ML model is loaded
		//this.ready2 = false; // becomes true when audio data is piped to this module. managed externally
		//this.finalCallback = null;
		//this.readyToCallFinal = false;
		//this.dataWrittenSinceLastSeg = false;

		this.preemphasislastValue = 0;
		this.SAMPLING_RATE = 22050;
		this.INTAKE_SECONDS = 4; // formerly nnXlenT

		this.PREEMPHASIS_FACTOR = 0.97; // 0 = no preemphasis

		this.MFCC_WINLEN = 0.05; // compute each MFCC frame with a window of that length (in seconds)
		this.MFCC_WINSTEP = 0.02; // how many seconds to step between each MFCC frame
		this.MFCC_NFFT = 2048;
		this.FFT = new dsp.FFT(this.MFCC_NFFT, this.SAMPLING_RATE);
		this.MFCC_NFILT = 26; // number of filter banks in MFCC
		this.MFCC_NCEPS = 13; // number of cepstral coefficients to output
		this.MFCC_LIFT = 22; // lifting coefficient for computed MFCC
		this.MFCC = mfcc.construct(this.MFCC_NFFT, this.MFCC_NFILT, 1e-8, this.SAMPLING_RATE / 2, this.SAMPLING_RATE);

		this.LSTM_INTAKE_SECONDS = 4; //nnXLenT = 4.0  # window of data intake, in seconds
		this.LSTM_INTAKE_FRAMES = Math.floor(this.LSTM_INTAKE_SECONDS / this.MFCC_WINSTEP); //nnXLen = int(round(nnXLenT / mfccStepT))  # data intake in points
		this.LSTM_STEP_SECONDS = 0.19*4; //nnXStepT = 0.19*4 # compute one LSTM prediction every N seconds.
		this.LSTM_STEP_FRAMES = Math.round(this.LSTM_STEP_SECONDS / this.MFCC_WINSTEP); //nnXStep = int(round(nnXStepT / mfccStepT)) # amount of cepstral spectra read for each LSTM prediction
	}

	/*spawn() { // spawn python subprocess
		const self = this;
		log.info("__dirname=" + __dirname);

		const isPKG = __dirname.indexOf("/snapshot/") === 0 || __dirname.indexOf("C:\\snapshot\\") === 0; // in a PKG environment (https://github.com/zeit/pkg)
		const isElectron = !!(process && process.versions['electron']); // in a Electron environment (https://github.com/electron/electron/issues/2288)

		log.info("env: PKG=" + isPKG + " Electron=" + isElectron);

		if (isPKG) {
			this.predictChild = cp.spawn(process.cwd() + "/dist/mlpredict/mlpredict",
				[ this.canonical ], { stdio: ['pipe', 'pipe', 'pipe']});
		} else if (isElectron) {
			const paths = [
				"",
				"/Adblock Radio Buffer-linux-x64/resources/app"
			];

			for (let i=0; i<paths.length; i++) {
				const path = process.cwd() + paths[i] + "/node_modules/adblockradio/predictor-ml/dist/mlpredict/mlpredict"
				try {
					fs.accessSync(path);
					log.info("mlpredict found at " + path);
					this.predictChild = cp.spawn(path, [ this.canonical ], { stdio: ['pipe', 'pipe', 'pipe']});
					break;
				} catch (e) {
					// pass
				}
				if (i === paths.length - 1) {
					const msg = "Could not locate mlpredict. cwd=" + process.cwd() + " paths=" + JSON.stringify(paths);
					log.error(msg);
					throw new Error(msg);
				}
			}

		} else {
			this.predictChild = cp.spawn('python', [
				'-u',
				__dirname + '/mlpredict.py',
				this.canonical,
			], { stdio: ['pipe', 'pipe', 'pipe'] });
		}
		// increase default timeouts, otherwise this would fail at model loading on some CPU-bound devices.
		// https://github.com/0rpc/zerorpc-node#clients
		this.client = new zerorpc.Client({ timeout: 120, heartbeatInterval: 60000 });
		this.client.connect("ipc:///tmp/" + this.canonical);

		this.client.on("error", function(error) {
			log.error(self.canonical + " RPC client error:" + error);
		});

		this.predictChild.stdout.on('data', function(msg) { // received messages from python worker
			const msgS = msg.toString().split("\n");

			// sometimes, several lines arrive at once. separate them.
			for (let i=0; i<msgS.length; i++) {
				if (msgS[i].length > 0) log.debug(msgS[i]);
			}
		});

		this.predictChild.stderr.on("data", function(msg) {
			if (msg.includes("Using TensorFlow backend.")) return;
			log.error(self.canonical + " mlpredict child stderr data: " + msg);
		});
		this.predictChild.stdin.on("error", function(err) {
			log.warn(self.canonical + " mlpredict child stdin error: " + err);
		});
		this.predictChild.stdout.on("error", function(err) {
			log.warn(self.canonical + " mlpredict child stdout error: " + err);
		});
		this.predictChild.stderr.on("error", function(err) {
			log.warn(self.canonical + " mlpredict child stderr error: " + err);
		});
		this.predictChild.stdout.on("end", function() {
			//log.debug("cp stdout end");
			self.readyToCallFinal = true;
			if (self.finalCallback) self.finalCallback();
		});
	}*/

	async load() {
		const path = 'https://www.adblockradio.com/models/' + this.canonical + '/model.json';
		this.model = await tf.loadModel(path);
		log.info(this.canonical + ' ML model loaded');

		/*const self = this;
		this.cork();
		this.ready = false;
		this.client.invoke("load", fileModel, function(error, res, more) {
			if (error) {
				if (error === "model not found") {
					log.error(self.canonical + " Keras ML file not found. Cannot tag audio");
				} else {
					log.error(error);
				}
				return callback(error);
			}

			log.info(self.canonical + " predictor process is ready to crunch audio");
			self.ready = true;
			self.uncork();
			return callback(null);
		});*/
	}

	_write(buf, enc, next) {
		log.debug("write " + buf.length / 2 + " samples to the working buffer");
		this.workingBuf = this.workingBuf ? Buffer.concat([this.workingBuf, buf]) : buf;



		/*this.dataWrittenSinceLastSeg = true;
		const self = this;
		this.client.invoke("write", buf, function(err, res, more) {
			if (err) {
				log.error(self.canonical + " _write client returned error=" + err);
			}
		});*/
		next();
	}

	predict(callback) {
		if (!this.workingBuf) {
			log.warn("empty buffer. skip");
			return setImmediate(callback);
		}
		const nSamples = this.workingBuf.length / 2;
		const duration = nSamples / this.SAMPLING_RATE;
		log.debug("will analyse " + duration + " s (" + nSamples + " samples)");


		// compute RMS for volume normalization
		let s = 0;
		for (let i=0; i<nSamples; i++) {
			s += Math.pow(this.workingBuf.readInt16LE(2*i), 2);
		}
		const rms = isNaN(s) ? 70 : 20 * Math.log10(Math.sqrt(s/nSamples))
		log.debug("segment rms=" + rms + " dB");

		// we are going to work on a buffer that is longer than just buf. we also include older data.
		//this.workingBuf = this.workingBuf ? Buffer.concat([ this.workingBuf, buf ]) : buf;

		//tmp = np.frombuffer(data, dtype="int16") # single channel only
		//self.pcm = tmp if self.pcm is None else np.append(self.pcm, tmp)

		// number of samples for data intake
		//const intake_samples = Math.floor((this.INTAKE_SECONDS + duration) * this.SAMPLING_RATE);
		// why not
		const intake_samples = Math.floor(this.INTAKE_SECONDS * this.SAMPLING_RATE);

		//pcm_len_limit = int((nnXLenT + duration) * self.sampleRate)
		/*if len(self.pcm) > pcm_len_limit:
			logger.debug("need to truncate pcm from " + str(len(self.pcm)) + " to " + str(pcm_len_limit))
			self.pcm = self.pcm[-pcm_len_limit:]*/

		if (this.workingBuf.length / 2 > intake_samples) {
			log.debug("Working buf will be truncated from " + (this.workingBuf.length / 2) + " samples to " + intake_samples);
			this.workingBuf = this.workingBuf.slice(-intake_samples);
			log.debug("working buf new length=" + (this.workingBuf.length / 2));
		}

		const nWorkingSamples = this.workingBuf.length / 2;

		// pre-emphasis
		const filtered = new Array(nWorkingSamples);
		filtered[0] = this.workingBuf.readInt16LE(0); // - this.PREEMPHASIS_FACTOR * ;
		for (let i=1; i<nWorkingSamples; i++) {
			filtered[i] = this.workingBuf.readInt16LE(2*i) - this.PREEMPHASIS_FACTOR * this.workingBuf.readInt16LE(2*(i-1));
		}


		// here TODO
		// build the windowing system.
		const nWin = Math.floor((nWorkingSamples - this.MFCC_WINLEN * this.SAMPLING_RATE) / (this.MFCC_WINSTEP * this.SAMPLING_RATE));
		log.debug(nWorkingSamples + " samples ready to be converted to in " + nWin + " series of " + this.MFCC_NCEPS + " MFCC");
		const ceps = new Array(nWin);

		for (let i=0; i<nWin; i++) {
			let data = filtered.slice(this.SAMPLING_RATE*i*this.MFCC_WINSTEP, this.SAMPLING_RATE*(i*this.MFCC_WINSTEP + this.MFCC_WINLEN));
			if (data.length < this.MFCC_NFFT) { // pad with zeros
				const nZeros = this.MFCC_NFFT - data.length;
				data = data.concat(new Array(nZeros).fill(0));
				//log.debug("fill with " + nZeros + " zeros");
			}
			//log.debug("preemphasized data");
			//log.debug(data.map(d => Math.round(d)));
			this.FFT.forward(data); // compute FFT in-place
			let energy = 0;
			for (let j=0; j<data.length; j++) { // get the power spectrum
				data[j] = Math.pow(data[j], 2);
				energy += data[j];
			}
			//log.debug("Power spectrum");
			//log.debug(data.map(d => Math.round(d)));
			const mfccData = this.MFCC(data, true);
			ceps[i] = [ mfccData.power ].concat(mfccData.melCoef);
			if (i === 0) {
				log.debug("ceps[0] nceps " + ceps[0].length);
			}

			// replace first cepstral coefficient with log of frame energy
			ceps[i][0] = Math.log(energy);

			//log.debug("ceps");
			//log.debug(JSON.stringify(ceps[i]));

			// cepstra lifter (boost higher frequencies)
			for (let j=0; j<this.MFCC_NCEPS; j++) {
				ceps[i][j] *= 1 + (this.MFCC_LIFT/2) * Math.sin(Math.PI * j / this.MFCC_LIFT)
			}

			//log.debug("After lifting:");
			//log.debug(ceps[i]);
		}

		// now ceps is an array of nWin frames of this.MFCC_NCEPS values.
		log.debug("ceps 2D array dim=" + nWin + "x" + ceps[0].length);

		/*# compute a series of mel-frequency cepstral coefficients
		ceps = psf.mfcc(
			self.pcm,
			samplerate=self.sampleRate,
			winlen=mfccWinlen,
			winstep=mfccStepT,
			numcep=mfccNceps,
			nfilt=26,
			nfft=2048,
			lowfreq=0,
			highfreq=None,
			preemph=0.97,
			ceplifter=22,
			appendEnergy=True
		)*/

		/*#t2 = timer()
		if ceps.shape[0] < nnXLen:
			prevshape = ceps.shape
			ceps = np.pad(ceps, ((nnXLen-ceps.shape[0], 0),(0,0)), 'edge')
			logger.debug("ceps extended from " + str(prevshape) + " to " + str(ceps.shape))*/

		if (nWin < this.LSTM_INTAKE_FRAMES) {
			// audio input is shorter than LSTM window
			// left-pad with identical frames
			const nMissingFrames = this.LSTM_INTAKE_FRAMES - nWin;
			log.warn(nMissingFrames + " frames missing to fit lstm intake")
			const refFrame = ceps[0].slice();
			for (let i=0; i<nMissingFrames; i++) {
				ceps.unshift(refFrame);
			}
		}


		const nLSTMPredictions = Math.floor((ceps.length - this.LSTM_INTAKE_FRAMES) / this.LSTM_STEP_FRAMES) + 1;
		log.debug(ceps.length + " frames will be sent to LSTM, in " + nLSTMPredictions + " chunks.");
		const MLInputData = new Array(nLSTMPredictions);

		for (let i=0; i<nLSTMPredictions; i++) {
			MLInputData[i] = ceps.slice(i*this.LSTM_STEP_FRAMES, i*this.LSTM_STEP_FRAMES + this.LSTM_INTAKE_FRAMES);
		}


		/*nframes = ceps.shape[0]
		nwin = int(math.floor((nframes-nnXLen) / nnXStep))+1
		t = [1.*nnXLenT/2 + nnXStepT*i for i in range(nwin)]
		logger.debug("ceps.shape " + str(ceps.shape) + " nnXLen " + str(nnXLen) + " nnXStep " + str(nnXStep) + " nwin " + str(nwin))
		X = np.empty([nwin, nnXLen, mfccNceps])

		#t3 = timer()
		for i in range(nwin):
			X[i,:,:] = ceps[i*nnXStep:(i*nnXStep+nnXLen),:]
		*/

		//predictions = self.model.predict(X, verbose=debug)
		this.model.predict(tf.tensor3d(MLInputData)).print();

		/*
		#t4 = timer()

		mp = np.mean(predictions, axis=0)
		mp_ref = np.array(mp, copy=True)
		predclass = np.argmax(mp)
		mp.sort()
		confidence = 1.0-math.exp(1-mp[2]/mp[1])
		logger.debug("mpref " + str(mp_ref))
		logger.debug("mp " + str(mp))
		logger.debug("confidence " + str(confidence))
		logger.debug("rms " + str(rms))

		result = json.dumps({
			'type': predclass,
			'data': predictions.tolist(),
			'confidence': confidence,
			'softmax': mp_ref.tolist(),
			'rms': rms,
			'mem': process.memory_info().rss,
			'lenpcm': len(self.pcm),
			#'timings': {'mfcc': str(t2-t1), 'inference': str(t4-t3)}
		})

		logger.info("audio predicted probs=" + result)*/

		//return result

		return setImmediate(callback);


		/*const self = this;
		if (!this.dataWrittenSinceLastSeg) {
			if (this.ready2) log.warn(this.canonical + " skip predict as no data is available for analysis");
			return callback();
		}
		this.dataWrittenSinceLastSeg = false;
		this.client.invoke("predict", function(err, res, more) {
			if (err) {
				log.error(self.canonical + " predict() returned error=" + err);
				return callback(err);
			}
			try {
				var results = JSON.parse(res);
				//log.debug("results=" + JSON.stringify(results))
			} catch(e) {
				log.error(self.canonical + " could not parse json results: " + e + " original data=|" + res + "|");
				return callback(err);
			}

			let outData = {
				type: results.type,
				confidence: results.confidence,
				softmaxraw: results.softmax.concat([0]), // the last class is about jingles. ML does not detect them.
				//date: new Date(stream.lastData.getTime() + Math.round(stream.tBuffer*1000)),
				gain: results.rms,
				lenPcm: results.lenpcm
			}

			self.push({ type:"ml", data: outData, array: true });
			callback(null, outData);
		});*/
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
