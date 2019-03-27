// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const sqlite3 = require("sqlite3").verbose();
const { Writable } = require("stream");
const { log } = require("abr-log")("pred-hotlist");
const Codegen = require("stream-audio-fingerprint");
const async = require("async");

const consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "3-jingles"],
	EMPTY_OUTPUT: {
		file: null,                 // file in DB that has lead to the maximum number of matching fingerprints in sync.
		class: null,                // integer representing the classification of that file, as an index of consts.WLARRAY
		diff: null,                 // time delay between the two compared series of fingerprints that maximizes the amount of matches. units are defined in Codegen lib.
		matchesSync: 0,             // amount of matching fingerprints, at the correct time position
		matchesTotal: 0,            // amount of matching fingerprints, at any time position
		confidence1: 0,
		confidence2: 0,
		softmaxraw: [1/4, 1/4, 1/4, 1/4],
	}
}

const toFixed = function(num, digits) {
	return Math.round(num * Math.pow(10, digits)) / Math.pow(10, digits);
}

class Hotlist extends Writable {
	constructor(options) {
		super({ objectMode: true });
		this.country = options.country;
		this.name = options.name;
		const path = options.fileDB || "predictor-db/hotlist" + '/' + this.country + "_" + this.name + ".sqlite";
		const MEMORY_DB = options.memoryDB === undefined ? true : !!options.memoryDB;

		this.fingerprinter = new Codegen();
		this.fingerbuffer = { tcodes: [], hcodes: [] };
		this.onFingers = this.onFingers.bind(this);
		let self = this;
		this.fingerprinter.on("data", function(data) {
			self.fingerbuffer.tcodes.push(...data.tcodes);
			self.fingerbuffer.hcodes.push(...data.hcodes);
			//log.debug(JSON.stringify(data));
		});

		log.info("open hotlist db " + path + " (memory=" + MEMORY_DB + ")");
		this.ready = false;
		this.trackList = [];

		async.waterfall(MEMORY_DB ? [
			// dumping the database in memory annihilates the I/O load and allows updates of the db file during operations.
			// to turn off if the database is too large for the available memory.
			function(cb) {
				self.db = new sqlite3.Database(':memory:', cb);
			}, function(cb) {
				self.db.run('ATTACH \'' + path + '\' AS M', cb);
			}, function(cb) {
				log.info(path + " db found");
				self.db.run('CREATE TABLE IF NOT EXISTS "tracks" (' +
					'`file` TEXT NOT NULL UNIQUE,' +
					'`class` INTEGER NOT NULL,' +
					'`id` INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE,' +
					'`fingersCount` INTEGER,' +
					'`length` INTEGER)', cb);
			}, function(cb) {
				self.db.run('CREATE TABLE IF NOT EXISTS "fingers" (' +
					'`track_id` INTEGER NOT NULL,' +
					'`dt` INTEGER NOT NULL,' +
					'`finger` INTEGER NOT NULL)', cb);
			}, function(cb) {
				self.db.run('CREATE TABLE IF NOT EXISTS "info" (' +
					'`modelsha` TEXT NOT NULL)', cb);
			}, function(cb) {
				self.db.run('CREATE INDEX IF NOT EXISTS "fingerIndex" ' +
					'ON "fingers" ("finger")', cb);
			}, function(cb) {
				const fields = 'file, class, id, fingersCount, length';
				self.db.run('INSERT INTO main.tracks(' + fields + ') ' +
					'SELECT ' + fields + ' FROM M.tracks', cb);
			}, function(cb) {
				const fields = 'track_id, dt, finger';
				self.db.run('INSERT INTO main.fingers(' + fields + ') ' +
					'SELECT ' + fields + ' FROM M.fingers', cb);
			}, function(cb) {
				self.db.run('DETACH M', cb);
			}, function(cb) {
				self.db.all('SELECT file, fingersCount, length FROM tracks;', cb);
			}, function(trackList, cb) {
				self.trackList = trackList;
				log.info(self.country + "_" + self.name + ': Hotlist ready');
				self.ready = true;
				if (options.callback) options.callback();
				setImmediate(cb);
			}
		]
		:
		// loading operations when file is to be read directly
		[
			function(cb) {
				self.db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, cb);
			}, function(cb) {
				log.info(path + " found");
				self.db.all('SELECT file, fingersCount, length FROM tracks;', cb);
			}, function(trackList, cb) {
				self.trackList = trackList;
				log.info(self.country + "_" + self.name + ': Hotlist ready');
				self.ready = true;
				if (options.callback) options.callback();
				setImmediate(cb);
			}
		], function(err) {
			// example of err object structure: { "errno": 14, "code": "SQLITE_CANTOPEN" }
			if (err && err.code === "SQLITE_CANTOPEN") {
				log.warn(path + " not found, hotlist module disabled");
				self.db = null;
			} else if (err) {
				log.error(self.country + "_" + self.name + " unknown error: " + err);
				self.db = null;
			}
		});
	}

	_write(audioData, enc, next) {
		if (!this.db) return next();
		this.fingerprinter.write(audioData);
		next();
	}

	onFingers(callback) {
		if (!this.db) return callback ? callback(null) : null;

		let tcodes = this.fingerbuffer.tcodes;
		let hcodes = this.fingerbuffer.hcodes;
		this.fingerbuffer = { tcodes: [], hcodes: [] };
		if (!tcodes.length) {
			if (callback) callback(null, consts.EMPTY_OUTPUT);
			return log.warn("onFingers: " + this.country + "_" + this.name + " no fingerprints to search");
		}

		// create a single query for all fingerprints.
		var inStr = "(", fingerVector = [];
		for (var i=0; i<tcodes.length; i++) {
			inStr += (i == 0) ? "?" : ",?";
			fingerVector.push(hcodes[i]);
		}
		inStr += ")";

		//log.info(JSON.stringify(fingerVector, null, "\t"));

		let self = this;
		this.db.all("SELECT tracks.file as file, tracks.class as class, tracks.fingersCount as fingersCount, tracks.length as length, " +
			"id, dt, finger FROM fingers " +
			"INNER JOIN tracks ON tracks.id = track_id " +
			"WHERE finger IN " + inStr + ";", fingerVector, function(err, res) {

			if (err) {
				// sometimes the hotlist is not fully written to disk when it is opened
				// Error: SQLITE_ERROR: too many SQL variables
				// softfail in such circumstances
				if (callback) callback(null, consts.EMPTY_OUTPUT);
				return log.error("onFingers: " + self.country + "_" + self.name + " query error=" + err);
			}
			if (!res || !res.length) {
				//log.warn("onFingers: no results for a query of " + tcodes.length);
				if (callback) callback(null, consts.EMPTY_OUTPUT);
				return
			}

			//log.debug(availData.class + " => " + JSON.stringify(queryResults));
			//for (let i=0; i<res.length; i++) {
			//	res[i].dtquery = tcodes[hcodes.indexOf(res[i].finger)];
			//}

			let diffCounter = {};
			let maxDiff = NaN;
			let maxFile = "";
			let maxClass = NaN;
			let largestCount = 0;

			// we count the fingerprints that match for each dt interval.
			// tcodes[0] and res[0].dt are arbitrary constants.
			// diffCounter is a compilation of the results.
			// it stores, for each matching fingerprint, the alignment in time
			// and the file in database related to this fingerprint.
			// at the end, we select the file that had the most matching fingerprints at
			// a given alignment in time.
			for (let i=0; i<res.length; i++) {
				const deltaMeasure = tcodes[hcodes.indexOf(res[i].finger)] - tcodes[0];
				const deltaRef = res[i].dt - res[0].dt;
				const diff = deltaRef - deltaMeasure;
				//var diff = res[i].dt-res[0].dt-(res[0].dt-res[0].dtquery);

				if (!diffCounter[diff]) diffCounter[diff] = {};
				if (!diffCounter[diff][res[i].file]) diffCounter[diff][res[i].file] = { count: 0, resfingers: [] };
				//console.log(res[i].file);
				//console.log(diffCounter[diff])

				diffCounter[diff][res[i].file].count += 1; // instead of 1, you may apply different weights for each class res[i].class.
				diffCounter[diff][res[i].file].resfingers.push(i);

				if (diffCounter[diff][res[i].file].count > largestCount) {
					largestCount = diffCounter[diff][res[i].file].count;
					maxFile = res[i].file;
					maxDiff = diff;
					maxClass = res[i].class;
				}
			}
			//log.info("onFingers: nf=" + res.length + " class=" + consts.WLARRAY[maxClass] + " file=" + maxFile + " diff=" + maxDiff + " count=" + largestCount);

			// compute the average position and standard deviation for the group of fingerprints that lead to a match
			const o = diffCounter[maxDiff][maxFile];
			let avg = 0;
			let std = 0;
			for (let i=0; i<o.resfingers.length; i++) {
				avg += res[o.resfingers[i]].dt;
				std += Math.pow(res[o.resfingers[i]].dt - avg, 2);
			}
			avg /= o.resfingers.length;
			avg = Math.round(avg * self.fingerprinter.DT * 100) / 100;
			std = Math.sqrt(std) / o.resfingers.length;
			std = Math.round(std * self.fingerprinter.DT * 100) / 100;

			// get info about detected reference file
			const trackInfo = self.trackList.filter(t => t.file === maxFile);
			let durationRef = 0, fingersCountRef = 0;
			if (trackInfo.length) {
				durationRef = trackInfo[0].length / 1000;
				fingersCountRef = trackInfo[0].fingersCount;
			}

			// confidence factors
			const ratioFingersReference = largestCount / fingersCountRef; // how many of the fingerprints in the reference track have we detected here?
			const ratioFingersMeasurements = largestCount / tcodes.length; // how many of the fingerprints in the measurements have contributed to the detection?
			const matchingFocus = std ? durationRef / std : 0; // are fingerprints detections focused in time in the reference track? (<<1 = yes; ~1 = no)

			const targetConfidence1 = 0.01; // empirical threshold above which detections have been found to be reliable
			const targetConfidence2 = 0.02; // empirical threshold above which detections have been found to be reliable

			const activationFun = (x) => (1 - Math.exp(-x)); // f(x) ~ x near zero, then converges to 1. actFun(1) = 1 - e^-1 ~ 0.63
			const confidence1 = activationFun(ratioFingersReference * ratioFingersMeasurements / targetConfidence1);
			const confidence2 = activationFun(ratioFingersReference * ratioFingersMeasurements * matchingFocus / targetConfidence2);

			// softmax vector, similar to that of ML module.
			let softmax = new Array(4);
			for (let i=0; i<4; i++) {
				if (i === maxClass) {
					softmax[i] = 1/4 + 3/4 * confidence2;
				} else {
					softmax[i] = 1/4 - 1/4 * confidence2;
				}
			}

			const output = {
				// info about the reference file that owned the highest number of matching fingerprints at a given time alignment
				file: maxFile, // reference path
				class: maxClass, // class
				diff: maxDiff, // time alignment
				durationRef: durationRef, // duration (in seconds)
				fingersCountRef: fingersCountRef, // total amount of fingerprints

				// info about matching fingerprints
				matchesSync: largestCount, // amount of fingerprints matched, with a given time alignment
				matchesTotal: res.length, // amount of matched fingerprints between measurements and hotlist database, whatever the time alignment
				tRefAvg: avg, // average position of fingerprints in the reference file (in seconds)
				tRefStd: std, // standard deviation of position of fingerprints in the ref file (in seconds)

				// info about measurements
				fingersCountMeasurements: tcodes.length, // amount of fingerprints generated by measurements

				// confidence factors
				ratioFingersReference: toFixed(ratioFingersReference, 5),
				ratioFingersMeasurements: toFixed(ratioFingersMeasurements, 5),
				matchingFocus: toFixed(matchingFocus, 5),
				confidence1: toFixed(confidence1, 5),
				confidence2: toFixed(confidence2, 5),
				softmaxraw: softmax,
			}

			if (callback) callback(null, output);
		});
	}

	_final(next) {
		log.info(this.country + "_" + this.name + " closing hotlist DB");
		if (!this.db) return next();
		const self = this;
		this.db.close(function(err) {
			if (err) log.warn(self.country + "_" + self.name + " could not close DB. err=" + err);
			next();
		});
	}
}

module.exports = Hotlist;
