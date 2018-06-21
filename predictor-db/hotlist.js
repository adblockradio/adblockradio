"use strict";
const sqlite3 = require("sqlite3").verbose();
const { Transform } = require("stream");
const { log } = require("abr-log")("pred-hotlist");
const Codegen = require("stream-audio-fingerprint");
const fs = require("fs");
const async = require("async");
const cp = require("child_process");

const consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "3-jingles"],
	EMPTY_OUTPUT: {
		file: null, 				// file in DB that has lead to the maximum number of matching fingerprints in sync.
		class: null,				// integer representing the classification of that file, as an index of consts.WLARRAY
		diff: null,					// time delay between the two compared series of fingerprints that maximizes the amount of matches. units are defined in Codegen lib.
		matchesSync: 0,				// amount of matching fingerprints, at the correct time position
		matchesTotal: 0				// amount of matching fingerprints, at any time position
	}
}

class Hotlist extends Transform {
	constructor(options) {
		super({ objectMode: true });
		const country = options.country;
		const name = options.name;
		const path = options.fileDB || "predictor-db/hotlist" + '/' + country + "_" + name + ".sqlite";

		this.fingerprinter = new Codegen();
		this.fingerbuffer = { tcodes: [], hcodes: [] };
		this.onFingers = this.onFingers.bind(this);
		let self = this;
		this.fingerprinter.on("data", function(data) {
			self.fingerbuffer.tcodes.push(...data.tcodes);
			self.fingerbuffer.hcodes.push(...data.hcodes);
			//log.debug(JSON.stringify(data));
		});

		log.info("open hotlist db " + path)
		this.ready = false;
		this.db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, function(err) {
			// example of err object structure: { "errno": 14, "code": "SQLITE_CANTOPEN" }
			if (err && err.code === "SQLITE_CANTOPEN") {
				log.warn(path + " not found, hotlist module disabled");
				self.db = null;
			} else if (err) {
				log.error("unknown error: " + err);
				self.db = null;
			} else {
				log.info("db found");
				self.ready = true;
			}
		});
		//setInterval(self.onFingers, 2000); // search every 2 seconds, to group queries and reduce CPU & I/O load.
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
			this.push({ type: "hotlist", data: consts.EMPTY_OUTPUT });
			if (callback) callback(consts.EMPTY_OUTPUT);
			return log.warn("onFingers: no fingerprints to search");
		}

		// create a single query for all fingerprints.
		var inStr = "(", fingerVector = [];
		for (var i=0; i<tcodes.length; i++) {
			inStr += (i == 0) ? "?" : ",?";
			fingerVector.push(hcodes[i]);
		}
		inStr += ")";

		var results = {}

		let self = this;
		this.db.all("SELECT tracks.file as file, tracks.class as class, id, dt as dtquery, finger FROM fingers " +
			"INNER JOIN tracks ON tracks.id = track_id " +
			"WHERE finger IN " + inStr + ";", fingerVector, function(err, res) {

			if (err) return log.warn("onFingers: query error=" + err);
			if (!res || !res.length) {
				//log.warn("onFingers: no results for a query of " + tcodes.length);
				self.push({ type: "hotlist", data: consts.EMPTY_OUTPUT });
				if (callback) callback(consts.EMPTY_OUTPUT);
				return
			}

			//log.debug(availData.class + " => " + JSON.stringify(queryResults));
			for (let i=0; i<res.length; i++) {
				res[i].dtquery = tcodes[hcodes.indexOf(res[i].finger)];
			}

			let diffCounter = {};
			let maxDiff = NaN;
			let maxFile = "";
			let maxClass = NaN;
			let largestCount = 0;

			for (let i=0; i<res.length; i++) {
				var diff = res[i].dt-res[0].dt-(res[0].dt-res[0].dtquery);

				if (!diffCounter[diff]) diffCounter[diff] = new Object();

				if (!diffCounter[diff][res[i].file]) diffCounter[diff][res[i].file] = 0;

				diffCounter[diff][res[i].file] += 1;

				if (diffCounter[diff][res[i].file] > largestCount) {
					largestCount = diffCounter[diff][res[i].file];
					maxFile = res[i].file;
					maxDiff = diff;
					maxClass = res[i].class;
				}
			}
			//log.info("onFingers: nf=" + res.length + " class=" + consts.WLARRAY[maxClass] + " file=" + maxFile + " diff=" + maxDiff + " count=" + largestCount);

			const output = { file: maxFile, class: maxClass, diff: maxDiff, matchesSync: largestCount, matchesTotal: res.length }
			self.push({ type: "hotlist", data: output });
			if (callback) callback();
		});
	}

	_final(next) {
		log.info("closing hotlist DB");
		this.db.close(function(err) {
			if (err) log.warn("could not close DB. err=" + err);
			next();
		});
	}
}

module.exports = Hotlist;
