var consts = require("./util_consts");
var log = consts.log("mrs/io");

var fs = require("fs");
var mpegParsing = require("./mpeg_parsing.js");

var countDiff = require("./util_countdiff.js");

var DEBUG = false;

var setDebugMode = function() {
	DEBUG = true;
}


// IO functions

var loadFp = function(radioName, rowsById, ad, utilDb, callback) { // loads if necessary
	//log("loading fingerprints for ad " + ad, consts.LOG_DEBUG);
	if (!rowsById[ad]) {
		log("Warning, requested id " + ad + " not found. Abort", consts.LOG_WARN);
		callback("id not found");
		return;
	}
	//if (DEBUG) log("loading id=" + ad);
	if (rowsById[ad].fp) {
		callback(null);
	} else {
		utilDb.get(radioName, function(db) {	
			if (db == null) {
				log("db not found", consts.LOG_ERROR);
				callback("db not found");
				return;
			}
			db.all("SELECT finger, dt, ad FROM candidates_fingers WHERE ad = ?;", [ad], function(err, rows) {
				if (err != null) {
					log("sql request error, could not get fp for ad " + ad + " : " + err, consts.LOG_WARN);
				}
				rowsById[ad].fp = rows;
				
				var fileName = "candidates/" + rowsById[ad].file_name + ".mp3";
	
				fs.readFile(fileName, function(err, data) {
					if (err) {
						log("could not read file " + fileName + " : " + err, consts.LOG_ERROR);
						callback("could not read file");
					} else {
						//log("read " + data.length + " bytes from " + fileName, consts.LOG_DEBUG);
						rowsById[ad].audioData = data; //Buffer.concat([rowsById[ad].audioData, data]);
						callback(null);
					}
				});
			});
		});
	}
}

var loadFpBatch = function(radioName, rowsById, ads, utilDb, callback) {
	if (DEBUG) log("loadFpBatch for ids " + JSON.stringify(ads));
	var f = function(ads, i) {
		if (i >= ads.length) {
			callback(null);
			return;
		}
		loadFp(radioName, rowsById, ads[i], utilDb, function(err) {
			if (err) {
				callback(err);
			} else {
				f(ads, i+1);
			}
		});
	}
	f(ads,0);
}

var checkContinuity = function(rowsById, froms, tos) {
	// parse the date of audio files to check the continuity of the recording + the non overlapping of the sequences.

	var getDateOfId = function(id) {
		return new Date(rowsById[id].file_name.split('_')[0]);	
	}			

	if (froms && tos) {
		var segment_duration = consts.FLAG_DT_PRE + consts.FLAG_DT_POST;
	
		var fromDates = new Array(froms.length);
		for (var i=0; i<froms.length; i++) {
			fromDates[i] = getDateOfId(froms[i]);
			if (i>=1 && fromDates[i] - fromDates[i-1] > segment_duration * 1500) {
				//log("Error, the froms candidates have not been recorded continuously. The mrs could be incomplete. Abort", consts.LOG_WARN);
				return "the froms candidates have not been recorded continuously";
			}
		}
		
		var toDates = new Array(tos.length);
		for (var i=0; i<tos.length; i++) {
			toDates[i] = getDateOfId(tos[i]);			
			if (i>=1 && toDates[i] - toDates[i-1] > segment_duration * 1500) {
				//log("Error, the tos candidates have not been recorded continuously. The mrs could be incomplete. Abort", consts.LOG_WARN);
				return "the tos candidates have not been recorded continuously";
			}
		}
		
		if ((toDates[0] > fromDates[0] && toDates[0] < fromDates[fromDates.length-1]) || (fromDates[0] > toDates[0] && fromDates[0] < toDates[toDates.length-1])) {
			//log("Warning, sequences overlap. Abort", consts.LOG_WARN); // we stop, because we compare some audio with itself, so it's not a repetition.
			return "overlapping sequences";
		}
		
		
		/*var fromDateNew = getDateOfId(from);
		var fromDateBeg = getDateOfId(sequence.froms[0]);
		var fromDateEnd = getDateOfId(sequence.froms[sequence.froms.length-1]);
					
		var toDateNew = getDateOfId(to);
		var toDateBeg = getDateOfId(sequence.tos[0]);
		var toDateEnd = getDateOfId(sequence.tos[sequence.tos.length-1]);
		*/			
		

		
		/*if (froms.indexOf(from) == -1 && (fromDateNew - fromDateEnd > segment_duration * 1500 || fromDateBeg - fromDateNew > segment_duration * 1500)) {
			log("Error, the froms candidates have not been recorded continuously. The mrs could be incomplete. Abort", consts.LOG_ERROR);
			return "the froms candidates have not been recorded continuously";
		}
				
		if (tos.indexOf(to) == -1 && (toDateNew - toDateEnd > segment_duration * 1500 || toDateBeg - toDateNew > segment_duration * 1500)) { // 1500 = 1000 ms/s + 50% margin
			log("Error, the tos candidates have not been recorded continuously. The mrs could be incomplete. Abort", consts.LOG_ERROR);
			return "the tos candidates have not been recorded continuously";
		}*/
				
		/*if ((fromDateNew > toDateBeg && fromDateNew < toDateEnd) || (toDateNew > fromDateBeg && toDateNew < fromDateEnd)) {
			log("Warning, sequences overlap. Abort", consts.LOG_WARN); // we stop, because we compare some audio with itself, so it's not a repetition.
			return "overlapping sequences";
		}*/
	}
	return null; // OK
}


var generateAudioFile = function(rowsById, ids, ratioStart, ratioStop, fileName, callback) {
	var bufs = [];
	for (var i=0; i<ids.length; i++) {
		bufs.push(rowsById[ids[i]].audioData);
		/*try {
			fs.symlinkSync("../candidates/" + rowsById[ids[i]].file_name + ".mp3", fileName + "_" + ids[i] + ".mp3");
		} catch (e) {
			log("symlink error: " + e);
		}*/
	}
	var audioData = Buffer.concat(bufs);
	
	var parsingInfo = { "isInitialized": false };
	mpegParsing.locateHeaderNear(audioData, parsingInfo, Math.round(ratioStart*audioData.length), false);
	var byteStart = parsingInfo.lastHeaderIndex;
	mpegParsing.locateHeaderNear(audioData, parsingInfo, Math.round(ratioStop*audioData.length), true);
	var byteStop = parsingInfo.lastHeaderIndex;
	//var fileName = path + JSON.stringify(ids) + ".mp3";
	fs.writeFile(fileName, audioData.slice(byteStart, byteStop), function(err) {
		callback(err);
	});
}

var getLinks = function(radioName, t1, t2, utilDb, callback) {

	utilDb.get(radioName, function(db) {	
		if (db == null) {
			log("db not found", consts.LOG_ERROR);
			callback([]);
			return;
		}

		db.all("SELECT id, file_name, paired_with, flag_date FROM candidates ORDER BY id;", function(err, rows) {
			if (err != null) {
				log("sql request error: " + err, consts.LOG_WARN);
			}
			
			var links = [];
			var rowsById = new Object();
			
			if (rows.length == 0) {
				log("getLinks: warning, no pairs found", consts.LOG_WARN);
				callback(rowsById, links);
				return;
			}
			
			// list of links between candidates
			for (var i=0, limit=rows.length; i<limit; i++) {
				rowsById[rows[i].id] = rows[i];
				var date = new Date(rows[i].flag_date);
				if (rows[i].paired_with && date >= t1 && date < t2) {
					var startRow = rowsById[rows[i].paired_with];
					if (!startRow) {
						continue;
					}
					
					links.push({"from": startRow.id, "to":rows[i].id, "deltat": ((new Date(rows[i].flag_date)) - (new Date(startRow.flag_date))) }); // "tstart": startRow.flag_date,
				}
			}
			if (DEBUG) log(links.length + " links to process", consts.LOG_INFO);
			callback(rowsById, links);
		});
	});
}

var compareMrs = function(radioName, fileName, tFP, hFP, utilDb, callback) {
	utilDb.get(radioName, function(db) {	
		if (db == null) {
			log("db not found", consts.LOG_ERROR);
			callback([]);
			return;
		}
	
		db.get("SELECT id FROM mrs WHERE file_name = ?;",[fileName], function(err, row) {
			if (err || !row) {
				log(radioName + " could not find mrs with fileName " + fileName + " : " + err, consts.LOG_WARN);
				callback();
				return;
			}
					
			utilDb.lookForFingerprintsInDb(tFP, hFP, consts.DEST_MRS, radioName, consts.LOOKUP_TIMEOUT_REPLAY, row.id, function(admatches) {
				var results = { largest_count: 0, top_ad: -1, top_diff: 0, top_whitelist: 0, diff_counter: new Object() };
				countDiff(tFP, admatches, results, 1, false, radioName);
			
				var parent;
				if (results.largest_count >= consts.THR_RATIO_MATCH*tFP.length) {
					// parent recognized
					//log(fileName + " is similar to mrs # " + results.top_ad + " with " + results.largest_count + "/" + tFP.length + " matching fps", consts.LOG_INFO);
					parent = results.top_ad;
				} else {
					//log(fileName + " is not recognized among its little friends. only " + results.largest_count + "/" + tFP.length + " matching fps", consts.LOG_INFO);
					parent = "";
				}
		
		
				db.run("UPDATE mrs SET paired_with=? WHERE file_name=?", [parent, fileName], function(err) {
					if (err) {
						log(radioName + " error updating mrs parent : " + err, consts.LOG_WARN);
					}
		
					callback(); // TODO
				});
			});
		});
	});	
}


exports.setDebugMode = setDebugMode;
exports.generateAudioFile = generateAudioFile;
exports.checkContinuity = checkContinuity;
exports.loadFpBatch = loadFpBatch;
exports.getLinks = getLinks;
exports.compareMrs = compareMrs;
