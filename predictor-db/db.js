var sqlite3 = require("sqlite3").verbose();
var { Writable, Transform } = require("stream");
var fs = require("fs");
var log = require("loglevel");
log.setLevel("debug");
var cp = require("child_process");
var async = require("async");
var findDataFiles = require("./findDataFiles.js");

var consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "9-unsure", "mrs", "todo"],
	/*DEST_ADS: "ads",
	DEST_CANDIDATES: "candidates",
	DEST_MUSICS: "musics",
	DEST_MRS: "mrs",
	DEST_DISCARD: "discard",*/
	SAVE_EXT: { "MP3": "mp3", "AAC": "aac", "AAC+": "aac", "OGG": "ogg", "HLS": "aac" },
}

var dirDate = function(now) {
	return (now.getUTCFullYear()) + "-" + (now.getUTCMonth()+1 < 10 ? "0" : "") + (now.getUTCMonth()+1) + "-" + (now.getUTCDate() < 10 ? "0" : "") + (now.getUTCDate());
}

class Db {
	constructor(options) {
		this.country = options.country;
		this.name = options.name;
		this.path = options.path;
		this.ext = options.ext;
	}

	newAudioSegment(callback) {
		//var parent = (trackInfo.parent && trackInfo.parent.parentType == consts.DEST_CANDIDATES) ? trackInfo.parent.parent : null;
		//db.run("INSERT INTO " + type + " (radio, file_name, flag_date, fingerprints, paired_with, last_meta, duration) VALUES (?,?,?,?,?,?,?)",
		//	[radioName, trackInfo.fileName, trackInfo.isoDate, fingerprints.nFP, parent, trackInfo.metaLastTitle, JSON.stringify(trackInfo.predict)], trackInsertCallback);
		var now = new Date();
		var dir = this.path + "/records/" + dirDate(now) + "/" + this.country + "_" + this.name + "/todo/";
		var path = dir + now.toISOString();
		log.debug("saveAudioSegment: path=" + path);
		var self = this;
		cp.exec("mkdir -p \"" + dir + "\"", function(error, stdout, stderr) {
			if (error) {
				log.error("warning, could not create path " + path);
			}
			//log.debug("saveAudioSegment: callback");

			callback({
				fingerWriter: new FingerWriteStream(path + ".sqlite"),
				fingerFinder: new FingerFindStream({ country: self.country, name: self.name, path: self.path, audioFile: path, audioExt: self.ext }),
				audio: new fs.createWriteStream(path + "." + self.ext),
				metadata: new MetaWriteStream(path + ".json"),
				//dir: dir,
				//prefix: path
			});
		});
	}
}

class MetaWriteStream extends Writable {
	constructor(path) {
		super({ objectMode: true });
		this.file = new fs.createWriteStream(path);
		this.ended = false;
		this.meta = {};
	}

	_write(meta, enc, next) {
		if (!meta.type) {
			log.error("MetaWriteStream: no data type");
			return next();
		}
		//log.debug("MetaWriteStream: data type=" + meta.type);
		this.meta[meta.type] = meta.data;
		next();
	}

	_final(next) {
		//log.debug("MetaWriteStream: end. meta=" + JSON.stringify(this.meta));
		this.file.end(JSON.stringify(this.meta));
		this.ended = true;
		next();
	}
}

class FingerFindStream extends Transform {
	constructor(params) {
		var options = {
			objectMode: true,
			readableObjectMode: true,
			writableObjectMode: true,
			//writableHighWaterMark: 10
		// setting this value too high will cause lost queries.
		// too low and it will be slow and add latency in the pipeline.
		}
		super(options);
		this.country = params.country;
		this.name = params.name;
		this.path = params.path;
		this.audioFile = params.audioFile;
		this.audioExt = params.audioExt;
		this.buffer = { tcodes: [], hcodes:[] };
		this.cork();
		var before = new Date(+new Date() - 5*60000).toISOString(); // do not look at very recent audio.
		var self = this;
		findDataFiles({ before: before, path: this.path, country: this.country, name: this.name }, function(classes) {
			self.classes = classes;
			self.uncork();
		});
	}

	_write(fingerprints, enc, next) {
		this.buffer.tcodes = this.buffer.tcodes.concat(fingerprints.tcodes);
		this.buffer.hcodes = this.buffer.hcodes.concat(fingerprints.hcodes);
		next();
	}

	_final(next) {
		var fingerprints = this.buffer;
		//log.debug("FingerFindStream: received " + fingerprints.tcodes.length + " fingerprints");
		var self = this;
		var results = new Object();
		for (let i=0; i<consts.WLARRAY.length; i++) {
			results[consts.WLARRAY[i]] = {};
		}
		var foundFingerprints = 0;
		async.forEach(this.classes, function(files, classCallback) {
			async.forEachOf(files, function(availData, path, filesCallback) {
				if (!availData.sqlite) return filesCallback();
				//log.debug("FingerReadStream: file=" + path + " class=" + availData.class);
				var inStr = "(", fingerVector = [];
				for (var i=0; i<fingerprints.tcodes.length; i++) {
					inStr += (i == 0) ? "?" : ",?";
					fingerVector.push(fingerprints.hcodes[i]);
				}
				inStr += ")";

				var db = new sqlite3.Database(path + ".sqlite", sqlite3.OPEN_READONLY);
				db.all("SELECT dt, finger FROM fingers WHERE finger IN " + inStr + ";", fingerVector, function(err, queryResults) {
					if (err) {
						log.warn("FingerFindStream: query error=" + err + " path=" + path);
						if (err == "Error: SQLITE_ERROR: no such table: fingers") { // in general, db was created but left empty. delete it.
							log.warn("FingerFindStream: delete " + path + ".sqlite");
							fs.unlink(path + ".sqlite", function(errUnlink) {
								if (errUnlink) log.warn("FingerFindStream: error unlinking file. err=" + errUnlink);
							});
						}
					}
					if (queryResults && queryResults.length) {
						//log.debug(availData.class + " => " + JSON.stringify(queryResults));
						for (var i=0; i<queryResults.length; i++) {
							queryResults[i].dtquery = self.buffer.tcodes[self.buffer.hcodes.indexOf(queryResults[i].finger)];
						}

						//var ps = path.split("/");
						//results[availData.class][ps[ps.length-1]] = queryResults;
						results[availData.class][path + "." + self.audioExt] = queryResults;
						foundFingerprints += queryResults.length;
					}
					filesCallback();
				});
			}, function(err) {
				if (err) log.warn("FingerFindStream: files iteration error=" + err);
				classCallback();
			});
		}, function(err) {
			if (err) log.warn("FingerFindStream: class iteration error=" + err);
			log.debug("FingerFindStream: found " + foundFingerprints + " matches for " + fingerprints.tcodes.length + " fingerprints");
			//self.push({ type: "fingerprints", data: results });
			var bestMatchesByClass = self.findBestMatch(self.audioFile + "." + self.audioExt, results);
			self.push({ type: "match", data: bestMatchesByClass });
			next();
		});
	}

	findBestMatch(refAudioFile, results) {
		// subroutine that performs a count of fingerprints matches vs delta t.
		// saves the file and dt of the highest occurring match.

		var diffCounter = {}, maxDiff = {}, maxFile = {}, largestCount = {};

		for (var typeclass in results) {
			diffCounter[typeclass] = {};
			maxDiff[typeclass] = NaN;
			maxFile[typeclass] = "";
			largestCount[typeclass] = 0;

			for (var file in results[typeclass]) {

				//diffCounter[typeclass][file] = [];
				var listm = results[typeclass][file];
				for (var i=0; i<listm.length; i++) {
					var diff = listm[i].dt-listm[i].dtquery-(listm[0].dt-listm[0].dtquery);
					if (!diffCounter[typeclass][diff]) {
						diffCounter[typeclass][diff] = new Object();
					}
					if (!diffCounter[typeclass][diff][file]) {
						diffCounter[typeclass][diff][file] = 0;
					}
					diffCounter[typeclass][diff][file] += 1;
					if (diffCounter[typeclass][diff][file] > largestCount[typeclass]) {
						largestCount[typeclass] = diffCounter[typeclass][diff][file];
						maxFile[typeclass] = file;
						maxDiff[typeclass] = diff;
					}
				}
			}
		}

		// is it recognized in todo folder but not in the other classes?
		var mrsNeeded = false;
		if (true || largestCount["todo"] >= 10) {
			mrsNeeded = true;
			for (typeclass in results) {
				if (typeclass === "todo") continue;
				if (largestCount[typeclass] > largestCount["todo"]) {
					mrsNeeded = false;
					break;
				}
			}
		}

		log.info("FindBestMatch: class=todo file=" + maxFile["todo"] + " diff=" + maxDiff["todo"] + " count=" + largestCount["todo"]);
		return {
			file: maxFile,
			diff: maxDiff,
			count: largestCount,
			mrs: mrsNeeded ? { new: refAudioFile, old: maxFile["todo"] } : null
		}
	}
}

class FingerWriteStream extends Writable {
	constructor(path) {
		//options.highWaterMark = 100;
		super({ objectMode: true });

		this.cork();
		var self = this;
		this.db = new sqlite3.Database(path);
		this.db.run("CREATE TABLE IF NOT EXISTS 'fingers' (`dt` INTEGER NOT NULL, `finger` INTEGER NOT NULL)", function(errCT) {
			if (errCT) log.error("FingerWriteStream: errCT=" + errCT + " path=" + path);
			self.db.run("CREATE INDEX IF NOT EXISTS FingersIndex ON fingers (finger)", function(errCI) {
				if (errCI) log.error("FingerWriteStream: errCI=" + errCI + " path=" + path);
				self.db.run("PRAGMA journal_mode = 'wal'", function(errPJ) {
					if (errPJ) log.error("FingerWriteStream: errPJ=" + errPJ + " path=" + path);
					self.uncork();
				});
			});
		});
		this.firstTcode = null;
	}

	_write(fingerprints, enc, next) {
		var self = this;
		if (this.firstTcode == null) this.firstTcode = fingerprints.tcodes[0];
		this.db.run("BEGIN TRANSACTION", function(errBT) {
			if (errBT) {
				return log.error("FingerWriteStream: errBT=" + errBT);
			}
			var stmt = self.db.prepare("INSERT INTO fingers (dt, finger) VALUES (?,?)");

			var run = function(j, callback) {
				if (j >= fingerprints.tcodes.length) {
					return callback();
				}
				//console.log("insert " + j);
				stmt.run([fingerprints.tcodes[j]-self.firstTcode, fingerprints.hcodes[j]], function(err) {
					if (err) {
						log.error("FingerWriteStream: fingerprint could not be inserted. j=" + j + " err=" + err);
					}
					run(j+1, callback);
				});
			}
			run(0, function() {
				stmt.finalize();
				self.db.run("END TRANSACTION;", function(errET) {
					if (errET) {
						log.error("FingerWriteStream: sqlite error, could not end transaction: " + errET);
					}
					//log(fingerprints.nFP + " fingerprints successfully added to the db " + typeWithWl + "/" + radioList[i] + " at #" + id + " for " + trackInfo.fileName, consts.LOG_INFO);
					//begin(radioList, i+1, db);
					next();
				});
			});
		})
	}

	_final(next) {
		this.db.close();
	}
}

module.exports = Db;
