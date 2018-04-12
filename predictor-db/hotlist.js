"use strict";
const sqlite3 = require("sqlite3").verbose();
const { Transform } = require("stream");
const { log } = require("../log.js")("pred-hotlist");
const Codegen = require("stream-audio-fingerprint");
const fs = require("fs");
const async = require("async");
const cp = require("child_process");

const consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "3-jingles"],
}

class Hotlist extends Transform {
	constructor(options) {
		super(options);
		this.country = options.country;
		this.name = options.name;
		this.fingerprinter = new Codegen();
		this.fingerbuffer = { tcodes: [], hcodes: [] };
		this.onFingers = this.onFingers.bind(this);
		let self = this;
		this.fingerprinter.on("data", function(data) {
			self.fingerbuffer.tcodes.push(...data.tcodes);
			self.fingerbuffer.hcodes.push(...data.hcodes);
			//log.debug(JSON.stringify(data));
		});
		this.ready = false;
		this.prepare();
	}

	_write(audioData, enc, next) {
		if (this.ready)	this.fingerprinter.write(audioData);
		next();
	}

	/*_final(next) {
		next();
	}*/

	onFingers() {

		let tcodes = this.fingerbuffer.tcodes;
		let hcodes = this.fingerbuffer.hcodes;
		this.fingerbuffer = { tcodes: [], hcodes: [] };
		if (!tcodes.length) return log.warn("onFingers: no fingerprints to search");

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

			if (err) {
				log.warn("onFingers: query error=" + err + " path=" + path);
				return;
			} else if (!res || !res.length) {
				log.warn("onFingers: no results for a query of " + tcodes.length);
				return;
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
			log.info("onFingers: nf=" + length + " class=" + consts.WLARRAY[maxClass] + " file=" + maxFile + " diff=" + maxDiff + " count=" + largestCount);
			self.push({ type: "match", data: { file: maxFile, diff: maxDiff, count: largestCount } });
		});
	}

	prepare() {
		let path = "./predictor-db/hotlist/" + this.country + "_" + this.name + ".sqlite";
		log.info("open db " + path)
		this.db = new sqlite3.Database(path); //, sqlite3.OPEN_READONLY);

		let commonPath = "./predictor-db/hotlist/" + this.country + "_" + this.name + "/";
		let jingles = commonPath + consts.WLARRAY[3] + "/";
		let self = this;

		async.waterfall([
			function(cb) {
				self.db.run('CREATE TABLE IF NOT EXISTS "tracks" (' +
					'`file`	TEXT NOT NULL UNIQUE,' +
					'`class`	INTEGER NOT NULL,' +
					'`id`	INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE)', cb);
			}, function(cb) {
				self.db.run('CREATE TABLE IF NOT EXISTS "fingers" (' +
					'`track_id`	INTEGER NOT NULL,' +
					'`dt`	INTEGER NOT NULL,' +
					'`finger`	INTEGER NOT NULL)', cb);
			}, function(cb) {
				self.db.all('SELECT * FROM tracks', cb);
			}, function(tracksDB, cb) {
				fs.readdir(jingles, function(err, jingleFiles) {
					cb(err, tracksDB, jingleFiles);
				});
			}, function(tracksDB, jingleFiles, cb) {
				// list the files on the drive that are not in the DB (and should)
				let trackList = tracksDB.map(e => e.file);
				let insertList = [];
				for (let i=0; i<jingleFiles.length; i++) {
					if (!trackList.includes(jingleFiles[i])) {
						insertList.push(jingleFiles[i]);
					}
				}

				let removeList = [];
				for (let i=0; i<trackList.length; i++) {
					if (!jingleFiles.includes(trackList[i])) {
						removeList.push(trackList[i]);
					}
				}
				cb(null, insertList, removeList);
			}, function(insertList, removeList, cb) {
				// insertion jobs
				async.eachSeries(insertList, function(item, callback) {
					log.info("insert jingle " + item + " in DB");
					async.waterfall([
						function(cb) {
							self.db.run("INSERT INTO tracks (file, class) VALUES (?,?)", [item, 3], cb);
						}, function(cb) {
							self.db.get("SELECT id FROM tracks WHERE file = ?", [item], cb);
						}, function(row, cb) {
							const readStream = fs.createReadStream(jingles + item);
							var decoder = cp.spawn('ffmpeg', [
								'-i', 'pipe:0',
								'-acodec', 'pcm_s16le',
								'-ar', 11025,
								'-ac', 1,
								'-f', 'wav',
								'-v', 'fatal',
								'pipe:1'
							], { stdio: ['pipe', 'pipe', process.stderr] });
							readStream.pipe(decoder.stdin);
							readStream.on("end", function() {
								log.debug("read finished");
							});

							const fingerprinter = new Codegen();
							decoder.stdout.pipe(fingerprinter);
							var tcodes = [];
							var hcodes = [];
							fingerprinter.on("data", function(fingers) {
								tcodes = tcodes.concat(fingers.tcodes);
								hcodes = hcodes.concat(fingers.hcodes);
							});
							fingerprinter.on("end", function() {
								cb(null, row.id, tcodes, hcodes);
							});
						}, function(id, tcodes, hcodes, cb) {
							self.db.run("BEGIN TRANSACTION", function(err) {
								var stmt = self.db.prepare("INSERT INTO fingers (dt, finger, track_id) VALUES (?,?,?)");
								cb(err, id, tcodes, hcodes, stmt);
							});
						}, function(id, tcodes, hcodes, stmt, cb) {
							async.eachOf(tcodes, function(tcode, i, callback) {
								stmt.run([tcode, hcodes[i], id], callback);
							}, cb);
						}, function(cb) {
							self.db.run("END TRANSACTION;", cb);
						}
					], callback);
				}, function(err) {
					if (err) log.warn("insertion error=" + err);
					cb(err, removeList);
				});
			}, function(removeList, cb) {
				// removal jobs
				async.eachSeries(removeList, function(item, callback) {
					log.info("remove track " + item + " from DB");
					async.waterfall([
						function(cb) {
							self.db.run("SELECT id FROM tracks WHERE file = ?", [item], cb);
						}, function(row, cb) {
							self.db.run("DELETE FROM fingers WHERE track_id = ?", [row.id], cb);
						}, function(cb) {
							self.db.run("DELETE FROM tracks WHERE file = ?", [item], cb);
						}
					], callback);
				}, function(err) {
					if (err) log.warn("removal error=" + err);
					cb(err);
				});
			}
		], function(err) {
			if (err) return log.error("could not prepare DB. err=" + err);
			log.info("DB ready: " + path);
			self.ready = true;
			setInterval(self.onFingers, 2000);
		});
	}
}


module.exports = Hotlist;
