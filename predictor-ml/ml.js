// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { Writable } = require("stream");
const { log } = require("abr-log")("pred-ml");
const cp = require("child_process");
const assert = require("assert");

function parse(msg) {
	try {
		return JSON.parse(msg);
	} catch (e) {
		log.error(self.canonical + ' could not parse response. msg=' + msg);
		return null;
	}
}

class MlPredictor extends Writable {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		this.verbose = options.verbose || false;
		this.ready = false; // becomes true when ML model is loaded
		//this.ready2 = false; // becomes true when audio data is piped to this module. managed externally
		//this.finalCallback = null;
		this.readyToCallFinal = false;
		this.modelFile = options.modelFile;
	}

	async load() {
		const self = this;
		return new Promise(function(resolve, reject) {
			self.child = cp.fork(__dirname + '/ml-worker.js', {
				env: {
					canonical: self.canonical,
					modelFile: self.modelFile,
				}
			});

			self.child.once('message', function(msg) {
				msg = parse(msg);
				assert.equal(msg.type, 'loading');
				if (msg.err) {
					log.warn(self.canonical + ' could not load model: ' + JSON.stringify(msg));
					return reject();
				}
				self.ready = msg.loaded;
				log.info(self.canonical + ' loaded=' + self.ready);
				resolve();
			});
		});
	}

	_write(buf, enc, next) {
		if (this.child && this.ready) {
			this.child.send(JSON.stringify({
				type: 'write',
				buf: buf,
			}));
		}
		next();
	}

	predict(callback) {
		if (this.child && this.ready) {
			this.child.send(JSON.stringify({
				type: 'predict',
			}));
			const self = this;
			this.child.once('message', function(msg) {
				msg = parse(msg);
				assert.equal(msg.type, 'predict');
				if (msg.err) log.warn(self.canonical + ' skipped prediction: ' + JSON.stringify(msg));
				callback(null, msg.outData);
			});
		}
	}

	_final() {
		if (this.child) {
			this.child.kill();
		}
	}
}

module.exports = MlPredictor;
