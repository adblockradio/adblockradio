// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { Transform } = require("stream");
const cp = require("child_process");
const { log } = require("abr-log")("pred-ml");

const consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "9-unsure", "todo"],
	STOP_WORD: "foobar1234",
	STOP_WORDS_COUNT: 1000 // have a 10*1000 = 10kbyte stop word is a good compromise between reactivity and respect on the CPU usage
}

class MlPredictor extends Transform {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		this.fileModel = options.fileModel || __dirname + "/model/" + this.canonical + ".keras";
		this.ready = false;
		this.onReadyCallback = options.onReadyCallback;
		const self = this;
		this.finalCallback = null;
		this.readyToCallFinal = false;
		this.dataWrittenSinceLastSeg = false;
		this.onDataCallback = null;

		// spawn python subprocess
		this.cork();
		this.predictChild = cp.spawn('python', [
			'-u',
			__dirname + '/mlpredict.py',
			this.canonical,
			this.fileModel,
			22050,				// hardcoded: sample rate
			1,					// hardcoded: number of channels
			16,					// hardcoded: bits per sample
			consts.STOP_WORD,	// stop word, to tell the subprocess to generate a prediction
			consts.STOP_WORDS_COUNT
		], { stdio: ['pipe', 'pipe', 'pipe'] });

		const onData = function(msg) {

			const optCallback = function() {
				if (self.onDataCallback) {
					self.onDataCallback();
					self.onDataCallback = null;
				}
			}

			if (msg.indexOf("model loaded") >= 0 && !self.ready) {
				log.info(self.canonical + " predictor process is ready to crunch audio");
				self.ready = true;
				if (self.onReadyCallback) {
					self.onReadyCallback();
					self.onReadyCallback = null;
				}
				optCallback();
				return self.uncork();
			}

			var parseTestText = "audio predicted probs=";
			var ijson = msg.indexOf(parseTestText) + parseTestText.length;
			if (ijson < parseTestText.length) {
				if (msg.includes("Model not found, cannot tag audio")) {
					log.error(self.canonical + " Keras ML file not found. Cannot tag audio");
				} else {
					log.debug(self.canonical + " mlpredict child: " + msg);
				}
				return; // optCallback();
			}

			try {
				var results = JSON.parse(msg.slice(ijson, msg.length));
			} catch(e) {
				log.warn(self.canonical + " could not parse json results: " + e + " original data=|" + msg.slice(ijson, msg.length) + "|");
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

			optCallback();
		}

		this.predictChild.stdout.on('data', function(msg) {
			//log('Received message from Python worker:\n' + msg.toString());
			const msgS = msg.toString().split("\n");

			//if (msg[msg.length-1] == "\n") msg = msg.slice(0,msg.length-1); // remove \n at the end

			// sometimes, several lines arrive at once. separate them.
			for (let i=0; i<msgS.length; i++) {
				if (msgS[i].length > 0) onData(msgS[i]);
			}
		});

		this.predictChild.stderr.on("data", function(msg) {
			log.warn(self.canonical + " mlpredict child stderr data: " + msg);
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
			//log.debug("pc stdout end");
			self.readyToCallFinal = true;
			if (self.finalCallback) self.finalCallback();
		});

	}

	_sendStopWord() {
		this.predictChild.stdin.write(consts.STOP_WORD.repeat(consts.STOP_WORDS_COUNT));
		this.predictChild.stdin.write(Buffer.alloc(consts.STOP_WORD.length*consts.STOP_WORDS_COUNT*10, ' '));
	}

	sendStopWord(callback) {
		if (this.dataWrittenSinceLastSeg) { // avoid sending a stop word after zero data. this is the way to close the predictChild.
			//log.debug("send stop word to ML subprocess");
			this._sendStopWord();
			this.dataWrittenSinceLastSeg = false;
			this.onDataCallback = callback;
		} else if (callback) {
			if (this.ready2) log.warn(this.canonical + " stopword sent but no data written since last one");
			callback();
		}
	}

	_write(buf, enc, next) {
		this.dataWrittenSinceLastSeg = true;
		this.predictChild.stdin.write(buf);
		next();
	}

	_final(next) {
		log.info("closing ML predictor");
		//log.debug("ml.js final");

		// sending two consecutive stop words without
		// data in between causes the child process to exit.
		this._sendStopWord();
		this._sendStopWord();

		// if not enough, kill it directly!
		this.predictChild.stdin.end();
		this.predictChild.kill();

		//if (this.readyToCallFinal) return next();
		this.readyToCallFinal = next;
	}
}

module.exports = MlPredictor;
