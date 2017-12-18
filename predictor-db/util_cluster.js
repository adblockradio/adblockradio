var consts = require("./util_consts.js");
var log = consts.log("util/cluster");

var fs = require('fs-extra');

var getSiblings = function(radioName, type, utilDb, callback) {

	switch (type) {
		case consts.DEST_ADS: 
			var rowName = "clusterAds"; break;
		case consts.DEST_MUSICS: 
			var rowName = "clusterMusics"; break;
		
		case consts.DEST_ADS + "_self":
		case consts.DEST_ADS + "_jingles":
		case consts.DEST_ADS + "_whitelist":
		case consts.DEST_CANDIDATES:
		case consts.DEST_MRS:
			callback([radioName]); return;// no clusters of candidates.
		
		default: log("wrong type requested: " + type, consts.LOG_ERROR); callback([]); return;
	}

	utilDb.get('glob').get("SELECT " + rowName + " FROM radio WHERE code = ?", radioName, function(err, row) {
		if (err) {
			log("WARNING, problem finding radio. " + err, consts.LOG_WARN);
			callback([]);
			return;
		}
		if (!row) {
			log("WARNING, no matching radio with name " + radioName + " in cluster " + rowName, consts.LOG_WARN);
			callback([]);
			return;
		}
		if (!row[rowName]) { // null or zero values do not make a cluster.
			callback([radioName]);
			return;
		}
		utilDb.get('glob').all("SELECT code FROM radio WHERE " + rowName + " = ?", row[rowName], function(err, rows) {
			if (err) {
				log("WARNING, problem finding siblings. " + err, consts.LOG_WARN);
				callback([]);
				return;
			}
			var result = [];
			for (var i=0; i<rows.length; i++) {
				result.push(rows[i].code);
			}
			//log("radio " + radioName + " has the following siblings in " + type + " : " + result);
			callback(result);
			return;
		});
	});
}


// fingerprint files in directory
var fingerprintDirectory = function(radioName, directory, limit, utilDb, parentCallback) {
	//log("fingerprinting directory " + directory, consts.LOG_INFO);
	getSiblings(radioName, directory, utilDb, function(siblings) {
		fs.readdir("./" + directory + "/", function(err, files) {
			//var fileList = [];
			
			var f = function(files, i, callback) {
				if (limit <= 0) {
					parentCallback();
					return;
				} else if (i >= files.length) {
					callback();
					return;
				}
				//if (siblings.indexOf(splitFileName(directory, files[i], true, null).radio) > -1 && files[i].slice(-4) == ".mp3") {	// will fp all files from sibling radios
				
				if (files[i].slice(-4) == ".mp3") files[i] = files[i].slice(0, files[i].length-4) // remove MP3 extension if present
				
				checkTrack(radioName, files[i], directory, siblings, utilDb, function(err, tracksInserted) {
					limit -= tracksInserted;
					f(files, i+1, callback);
				});
			}
			
			f(files, 0, function() {
			
				// remove entries in db if files are missing
				var obj = consts.getDirFromDestination(directory);
				var type = obj.dir;
				utilDb.get(radioName, function(db) {
					db.all("SELECT id, file_name FROM " + type + (type == consts.DEST_ADS ? (" WHERE whitelist = " + obj.whitelistCode) : "") + " ORDER BY " + ([consts.DEST_ADS, consts.DEST_CANDIDATES].indexOf(type) >= 0 ? " flag_" : "") + "date ASC;", function(errST, tracks) {
						if (errST) {
							log(radioName + " fingerprintDirectory: could not list " + type + " err=" + errST, consts.LOG_WARN);
							parentCallback();
							return;
						} else if (!tracks) {
							parentCallback();
							return;
						}
						
						var linTracks = [];
						for (var i=0; i<tracks.length; i++) {
							linTracks.push(tracks[i].file_name);
						}
						
						/*var diffArray = function(big, small) {
							return big.filter(function(i) {return small.indexOf(i) < 0;});
						};
						var tracksToRemove = diffArray(linTracks, files);*/
						
						var tracksToRemove = [];
						for (var i=0; i<linTracks.length; i++) {
							if (files.indexOf(linTracks[i]) < 0) {
								tracksToRemove.push(linTracks[i]);
								//log(linTracks[i] + " is in DB but NOT in " + radioName + " " + directory + " files");
							} //else {
							//	log(linTracks[i] + " is in DB & " + radioName + " " + directory + " files");
							//}
						}
						
						/*if (tracksToRemove.length > 0) {
							log(radioName + " fpD: " + linTracks[0]);
							log(radioName + " fpD: " + files[0]);
							log(radioName + " fpD: " + tracksToRemove[0]);
						}*/
						var f = function(files, i, callback) {
							if (i >= files.length || limit <= 0) {
								callback();
								return;
							}
							deleteTrack(radioName, type, { "fileName": files[i] }, utilDb, function(err, trackRemovedFileName) {
								if (trackRemovedFileName) {
									log(radioName + " fpD: obsolete db entry removed in " + directory + " " + trackRemovedFileName + ", " + (tracksToRemove.length-1) + " remaining", consts.LOG_WARN);
									limit -= 1; //trackRemovedFileName ? 1 : 0;
								}
								f(files, i+1, callback);
							});
						}
						
						f(tracksToRemove, 0, parentCallback);
						//parentCallback();
					});
				});
			
				//parentCallback();
			});
			/*for (var i=0;i<files.length;i++) {
				//if (splitFileName(directory, files[i]).radio == radioName && files[i].slice(-4) == ".mp3") {	
				if (siblings.indexOf(splitFileName(directory, files[i], true, null).radio) > -1 && files[i].slice(-4) == ".mp3") {	// will fp all files from sibling radios
					fileList.push(files[i].slice(0,files[i].length-4)); // check if file in ad list
				}
			}
			checkAmongCluster(radioName, fileList, directory, limit, utilDb, parentCallback);*/
		});
	});
}

var fingerprintFile = function(fileName, directory, targetRadio, utilDb, callback) {
	var options = { "adFileName":fileName, "directory":directory, "targetRadio": targetRadio, "utilDb": utilDb, "callback": function() { delete dummyStream; callback(); } };
	var Stream = require("./analyser_stream");
	var dummyStream = new Stream("dummy_fingerprint_this", options);
}

var checkTrack = function(radioName, fileName, typeWithWl, siblings, utilDb, parentCallback) {
	
	//var remainingFiles = limit ? limit : -1;
	
	splitFileName(typeWithWl, fileName, false, function(sfn) {
		
		if (siblings.indexOf(sfn.radio) < 0) {	// will fp all files from sibling radios
			parentCallback(null, 0);
			return;
		
		} else if (sfn.date &&
			(typeWithWl == consts.getDestinationFromWhitelistCode(consts.DB_AD) && sfn.date < (new Date() - consts.MAX_AGE_AD*86400000)) ||  // do not import old ads
			(typeWithWl == consts.getDestinationFromWhitelistCode(consts.DB_AD_SELF) && sfn.date < (new Date() - consts.MAX_AGE_AD*86400000)) || 
			(typeWithWl == consts.getDestinationFromWhitelistCode(consts.DB_WHITELIST) && sfn.date < (new Date() - consts.MAX_AGE_WHITELIST*86400000) ) ||
			(typeWithWl == consts.DEST_MUSICS && sfn.date < (new Date() - consts.MAX_AGE_MUSICS*86400000) )) {
			
			parentCallback(null, 0); //f(fileList, i+1, callback);
			return;
				
		} else {
		
			//log("checking " + typeWithWl + " in DB " + radioList[iradio] + " for " + sfn.fileName);
			utilDb.get(radioName, function(db) { 
				var obj = consts.getDirFromDestination(typeWithWl);
				var type = obj.dir;
				var wlCode = obj.whitelistCode;
				var wlReq = type == consts.DEST_ADS ? ", whitelist" : "";
				db.get("SELECT id, fingerprints" + wlReq + " FROM " + type + " WHERE file_name = ?;", [sfn.fileName], function(err, row) {
					if (err) {
						log(radioName + " checkTrack: sqlite error! file=" + sfn.fileName + " type=" + type + " : " + err, consts.LOG_WARN);
						parentCallback(err, 0);
						return;
					}
					if (row) { // already in radioName DB
						/*if (sfn.fileName == "2016-10-13T19:49:12.693Z_fr_virgin_monitor-mrs") {
							log("da mrs is here");
						}*/
						parentCallback(null, 0);
						return;
						
					} else if (row && type == consts.DEST_ADS && row.whitelist != wlCode) { // the ad is in the db, but with a wrong wlcode (the status of the ad/jingle has been changed)
					
						db.run("UPDATE " + type + " SET whitelist=" + wlCode + " WHERE id=?;", [row.id], function(errUW) {
							if (errUW) {
								log(radioName + " checkTrack: could not change wlcode ad=" + sfn.fileName + " " + row.whitelistCode + "=>" + wlCode, consts.LOG_WARN);
								parentCallback("cannot change whitelist code, abort", 0);
							} else {
								log(radioName + " checkTrack: wlcode of ad=" + sfn.fileName + " " + row.whitelistCode + "=>" + wlCode, consts.LOG_DEBUG);
								parentCallback(null, 0);
							}
						});
					
					} else { // not found in radioName DB
						
						fingerprintFile(sfn.fileName, typeWithWl, radioName, utilDb, function(t, h, id) { 
							log(radioName + " file " + sfn.fileName + " inserted in " + typeWithWl, consts.LOG_DEBUG);				
							parentCallback(null, 1);
							//f(fileList, i+1, callback);
							return;
						});
					}
				}); 
			});
		}
	});
}


var splitFileName = function(type, fileName, syncFlag, callback) {
	
	if (fileName.slice(-4) == ".mp3") fileName = fileName.slice(0, fileName.length-4) // remove MP3 extension if present
	
	if (type == consts.DEST_MUSICS) {
		var result = {"radio": fileName.split("-")[0], "date": null, "fileName": fileName, "uuid": null };
		if (syncFlag) {
			return result;
		} else {
			fs.stat(consts.DEST_MUSICS + "/" + fileName + ".mp3", function(err, stat) {
				//log("type musics radioname = " + fileName.split("-")[0] + " date = " + stat.mtime, consts.LOG_DEBUG);
				result.date = err ? null : new Date(stat.mtime);
				callback(result);
			//	callback({"radio": fileName.split("-")[0], "date": err ? null : new Date(stat.mtime), "fileName": fileName });
			});
		}
	} else {
		var tmp = fileName.split("_");
		var result = {"radio": tmp[1] + "_" + tmp[2], "date": new Date(tmp[0]), "fileName": fileName, "uuid": tmp[3] };
		//log("type " + type + " radioname = " + tmp[1] + "_" + tmp[2]);
		if (syncFlag) {
			return result
		} else {
			callback(result);
		}
	}
}

var saveTrack = function(radioName, typeWithWl, trackInfo, fingerprints, remainingRetries, utilDb, callback) {
	var obj = consts.getDirFromDestination(typeWithWl);
	var type = obj.dir;
	
	if (isNaN(remainingRetries)) remainingRetries = 5;
	
	var targetRadio = trackInfo.targetRadio ? trackInfo.targetRadio : radioName;
	//log("saving as " + typeWithWl + " the track " + trackInfo.fileName + " from " + radioName + " with " + fingerprints.nFP + " fps");

		
	utilDb.get(targetRadio, function(db) {  
		db.get("SELECT file_name FROM " + type + " WHERE file_name = ?", trackInfo.fileName, function(err, row) {
			if (err) {
				log(targetRadio + " saveTrack: sqlite error, could not check presence of track: " + err, consts.LOG_WARN);
			}
			if (row) {// && (type != consts.DEST_ADS || row.whitelist == obj.whitelistCode)) { // track already present, and, if ad, with the same whitelist code. in that case, skip
				//log("file_name " + trackInfo.fileName + " is already in DB " + radioList[i] + ", skip");
				//log(JSON.stringify(row));
				callback(null); //begin(radioList, i+1);
				return;
			//} else if (row && type == consts.DEST_ADS && row.whitelist != obj.whitelistCode) { // ad already present, but with the wrong whitelist code.
			
			} else {
				db.run("BEGIN TRANSACTION", function(errBT) {
					if (errBT) {
						log(targetRadio + " saveTrack: sqlite error, could not begin transaction, retrying in 1sec: " + errBT, consts.LOG_WARN);
						if (remainingRetries > 0) {
							(function(remainingRetries) { 
								setTimeout(function() { 
									db.run("END TRANSACTION", function(err) {
										saveTrack(radioName, typeWithWl, trackInfo, fingerprints, remainingRetries-1, utilDb, callback);
										//begin(radioList, i);   // retry later if lock is denied
									});
								}, 1000);
							})(remainingRetries);
						} else {
							callback(errBT);
						}
						return;
					}
					if (type == consts.DEST_ADS) {
						db.run("INSERT INTO " + type + " (radio, file_name, flag_uuid, flag_date, fingerprints, whitelist, duration) VALUES (?,?,?,?,?,?,?)", 
							[radioName, trackInfo.fileName, trackInfo.uuid, trackInfo.isoDate, fingerprints.nFP, obj.whitelistCode, trackInfo.duration], trackInsertCallback);
					} else if (type == consts.DEST_CANDIDATES) {
						var parent = (trackInfo.parent && trackInfo.parent.parentType == consts.DEST_CANDIDATES) ? trackInfo.parent.parent : null;
						db.run("INSERT INTO " + type + " (radio, file_name, flag_date, fingerprints, paired_with, last_meta, duration) VALUES (?,?,?,?,?,?,?)", 
							[radioName, trackInfo.fileName, trackInfo.isoDate, fingerprints.nFP, parent, trackInfo.metaLastTitle, JSON.stringify(trackInfo.predict)], trackInsertCallback);
					} else if (type == consts.DEST_MUSICS) {
						//var callback = (trackInfo.parent && trackInfo.parent.parentType == consts.DEST_MUSICS) ? function(err) { begin(radioList, i+1); } : trackInsertCallback; 
						log(targetRadio + " saveTrack: inserting music (radio, file_name, date, duration, fingerprints) " + radioName + " " + trackInfo.fileName + " " + trackInfo.isoDate + " " + trackInfo.duration + " " + fingerprints.nFP, consts.LOG_DEBUG);
						db.run("INSERT INTO " + type + " (radio, file_name, date, duration, fingerprints) VALUES (?,?,?,?,?)", 
							[radioName, trackInfo.fileName, trackInfo.isoDate, trackInfo.duration, fingerprints.nFP], trackInsertCallback); //trackInsertCallback);
					} else if (type == consts.DEST_MRS) {
						db.run("INSERT INTO " + type + " (radio, file_name, date, duration, fingerprints, paired_with) VALUES (?,?,?,?,?,?)", 
							[radioName, trackInfo.fileName, trackInfo.isoDate, trackInfo.duration, fingerprints.nFP, "pending"], trackInsertCallback);
					}
				});
			}
		});
		
		var trackInsertCallback = function(errIC) {
			if (errIC) {
				log(targetRadio + " sqlite error during saveNewAd: " + errIC, consts.LOG_WARN);
				db.run("END TRANSACTION;", function(errET) {
					if (errET) {
						log(targetRadio + " saveTrack: sqlite error, could not end transaction: " + errET, consts.LOG_WARN);
					}
					if (remainingRetries > 0) {
						(function(i) { 
							setTimeout(function() { 
								saveTrack(targetRadio, typeWithWl, trackInfo, fingerprints, remainingRetries-1, utilDb, callback);
								//begin(radioList, i); 
							}
						, 1000); })(remainingRetries);
						//remainingRetries--;
					} else {
						//log(fingerprints.nFP + " fingerprints successfully added to the db " + typeWithWl + "/" + radioList[i] + " at #" + id + " for " + trackInfo.fileName, consts.LOG_INFO);
						callback(errIC);
					}
				});
				return;
			}
		
			if (trackInfo.parent && trackInfo.parent.parentType == consts.DEST_MUSICS) { // do not save fingerprints for recognized musics
				callback(null);
			}
		
			// insert fingerprints now
			var stmt = db.prepare("INSERT INTO " + type + "_fingers (finger, ad, dt) VALUES (?,?,?)");
		
			var run = function(j,id) {
				//console.log("insert " + j);
				stmt.run([fingerprints.hFP[j], id, fingerprints.tFP[j]-fingerprints.tFP[0]], function(err) {
					if (err) {
						log(targetRadio + " saveTrack: fingerprint could not be inserted. id=" + id + " j=" + j, consts.LOG_WARN);
					}
					if (j+1 < fingerprints.nFP) {
						run(j+1,id);
					} else {
						stmt.finalize();
						db.run("END TRANSACTION;", function(err) {
							if (err) {
								log(targetRadio + " saveTrack: sqlite error, could not end transaction: " + err, consts.LOG_WARN);
							}
							//log(fingerprints.nFP + " fingerprints successfully added to the db " + typeWithWl + "/" + radioList[i] + " at #" + id + " for " + trackInfo.fileName, consts.LOG_INFO);
							//begin(radioList, i+1, db);
							callback(null);
						});
					}
				});
			}
			run(0, this.lastID);	
		}
		
	});
}

/*var deleteTrack = function(radioName, dbname, id, utilDb, callback) {

	utilDb.get(radioName, function(db) {
		if (!db) {
			log(radioName + " db not found!! (deleteTrack)", consts.LOG_WARN);
			callback(radioName, " db not found (deleteTrack)");
			return;
		}
		db.run("BEGIN TRANSACTION;", function(err0) {
			if (err0) {
				db.run("END TRANSACTION;", function(err00) {
					deleteTrack(radioName, dbname, id, utilDb, callback);
				});
				return;
			}
			db.run("DELETE FROM " + dbname + "_fingers WHERE ad = ?;", id, function(err2) {
				db.run("END TRANSACTION;", function(err1) {
					if (err2 != null) {
						log(radioName + " sql request error (delete track): " + err2, consts.LOG_WARN);
						callback(radioName + " sql request error (delete track): " + err2);
						return;
					}
		
					db.run("DELETE FROM " + dbname + " WHERE id = ?;", id, function(err3) {
						if (err3 != null) {
							log(radioName + " sql request error (delete track): " + err3, consts.LOG_WARN);
							callback(radioName + " sql request error (delete track): " + err3);
							return;
						}
						//log(radioName + " delete from DB: OK");
						
						callback(null);
					});
				});
			});
		});
	});
}*/

var deleteTrack = function(radioName, tableName, trackReference, utilDb, callback) {

	//var dbname = consts.getDirFromDestination(typeWithWl).dir;

	utilDb.get(radioName, function(db) {

		if (!db) {
			log(radioName + " db not found!! (deleteTrack)", consts.LOG_WARN);
			callback(radioName + " db not found (deleteTrack)", null);
			return;
		}

		var selectCallback = function(err, row) {
			//trackReference.id = row.id;
			//trackReference.file_name = row.file_name;
			
			var breakCallback = function(err) {
				callback(err, row ? row.file_name : null);
			}
				
			if (err) {
				log(radioName + " deleteTrack: sql select error : " + err, consts.LOG_WARN);
				return;
			}
			if (!row) {
				//log(radioName + " -> " + radioList[i] + " song does not exist in DB", consts.LOG_WARN);
				breakCallback(radioName + " song does not exist in DB");
				return;
			} else {
				//log(radioName + " -> " + radioList[i] + " song id is " + row.id);
			}

			//deleteTrack(radioList[i], dbname, row.id, utilDb, breakCallback);
				
			db.run("BEGIN TRANSACTION;", function(err0) {
				if (err0) {
					db.run("END TRANSACTION;", function(err00) {
						deleteTrack(radioName, tableName, trackReference, utilDb, callback);
					});
					return;
				}

				db.run("DELETE FROM " + tableName + "_fingers WHERE ad = ?;", row.id, function(err2) {
					db.run("END TRANSACTION;", function(err1) {
						if (err2 != null) {
							log(radioName + " sql request error (delete track): " + err2, consts.LOG_WARN);
							callback(radioName + " sql request error (delete track): " + err2, null);
							return;
						}
		
						db.run("DELETE FROM " + tableName + " WHERE id = ?;", row.id, function(err3) {
							if (err3 != null) {
								log(radioName + " sql request error (delete track): " + err3, consts.LOG_WARN);
								callback(radioName + " sql request error (delete track): " + err3, null);
								return;
							}
							//log(radioName + " delete from DB: OK");
							
							callback(null, row.file_name);
						});
					});
				});
			});			
		}
		
		if (!isNaN(trackReference.id) && trackReference.fileName) {
			//log(radioName + " -> " + radioName + " delete song " + tableName + "/" + trackReference.fileName + ".mp3 (id=" + trackReference.id + ")");
			db.get("SELECT id, file_name FROM " + tableName + " WHERE file_name = ? AND id = ?", ["'" + trackReference.fileName + "'", trackReference.id], selectCallback);
		} else if (trackReference.fileName) { // trackReference = { "fromName": true, "fileName": foo }
			//log(radioName + " -> " + radioName + " delete song " + tableName + "/" + trackReference.fileName + ".mp3");
			db.get("SELECT id, file_name FROM " + tableName + " WHERE file_name = ?", trackReference.fileName, selectCallback);
		} else if (!isNaN(trackReference.id)) { // trackReference = { "fromId": true, "id": 42 }
			//log(radioName + " -> " + radioName + " delete song " + tableName + "/id:" + trackReference.id );
			db.get("SELECT id, file_name FROM " + tableName + " WHERE id = ?", trackReference.id, selectCallback);
		}	 
	});	
}

var deleteOldTracks = function(radioName, where, limit, timeLimit, utilDb, callback) {

	var wlinfo = consts.getDirFromDestination(where);
	var tableName = wlinfo.dir;
	var wlcode = wlinfo.whitelistCode;

	var checkHistory = false;
	var limitSql = " LIMIT " + limit;
	var wlSql = "";
	
	if (where == consts.DEST_CANDIDATES) {
		var maxAge = consts.MAX_AGE_CANDIDATES, colAge = "flag_date";
	} else if (where == consts.DEST_MRS) {
		var maxAge = consts.MAX_AGE_MRS, colAge = "date";
	} else if (where == consts.getDestinationFromWhitelistCode(consts.DB_AD) || where == consts.getDestinationFromWhitelistCode(consts.DB_AD_SELF)) {
		var maxAge = consts.MAX_AGE_AD, colAge = "flag_date", checkHistory = true, limitSql = "", wlSql = "AND whitelist == " + wlcode + " ";
	} else if (where == consts.getDestinationFromWhitelistCode(consts.DB_WHITELIST)) {
		var maxAge = consts.MAX_AGE_WHITELIST, colAge = "flag_date", checkHistory = true, limitSql = ""; wlSql = "AND whitelist == " + wlcode + " ";
	} else if (where == consts.DEST_MUSICS) {
		//log(radioName + " deleteOldTracks: musics");
		var maxAge = consts.MAX_AGE_MUSICS, colAge = "date", checkHistory = true; limitSql = "";
	} else {
		log(radioName + " deleteOldTracks has a wrong 'where' argument: " + where, consts.LOG_WARN);
		callback();
		return;
	}
	
	var startDate = +new Date();
	var callbackDate = !isNaN(timeLimit) ? +new Date() + timeLimit : null;
	
	utilDb.get(radioName, function(db) {
		db.all("SELECT id, radio, file_name FROM " + tableName + " WHERE datetime(" + colAge + ") <= datetime('now','-" + maxAge + " day') " + wlSql + "ORDER BY " + colAge + limitSql, function(err, rows) { // AND radio == ?

			var f = function(rows, i) {
				if (callbackDate) {
					var dndc = +new Date() - callbackDate;
					var dnds = +new Date() - startDate
				}
				if (i >= rows.length) {
					callback();
					return;
				} else if (callbackDate && dndc > 0) {
					log(radioName + " deleteOldTracks stopped at " + i + "/" + rows.length + " in " + where + " because time limit " + timeLimit + " exceeded by " + dndc + "ms" + (i > 0 ? " (prev avg=" + Math.round(dnds/i) + " ms)" : ""), consts.LOG_INFO);
					callback();
					return;
				} else if (callbackDate && ((i > 0 && dndc + dnds/i/2 > 0) || (i > 1 && dndc + dnds/i > 0))) {
					log(radioName + " deleteOldTracks stopped at " + i + "/" + rows.length + " in " + where + " because time limit " + timeLimit + " will be exceeded (" + (-dndc) + "ms remaining, prev avg=" + Math.round(dnds/i) + "ms)", consts.LOG_INFO);
					callback();
					return;
				}
				
				if (checkHistory) { // when dealing with ads, only remove those which have not been broadcast for a while.
					db.get("SELECT * FROM history_" + tableName + " WHERE ad_id == ? AND datetime(date) >= datetime('now','-" + maxAge + " day')", [rows[i].id], function(err, row) {
						if (err) {
							log(radioName + " deleteOldTracks: could not check history of " + tableName + " id " + rows[i].id + " before deleting it, skip it. Err:" + err, consts.LOG_WARN);
							f(rows, i+1);
						} else if (row) {
							/*if (tableName == consts.DEST_MUSICS) {
								log(radioName + " music " + rows[i].id + " has been detected at " + JSON.stringify(row) + " (" + rows.length + " musics to inspect)", consts.LOG_DEBUG);							
							}*/
							f(rows, i+1); // do not delete current ad = skip it
						} else {
							deleteTrack(radioName, tableName, {"id": rows[i].id } , utilDb, function(err) { // delete track only in the db of the current radio.
							//deleteAmongCluster(radioName, tableName, {fromId:true, id:rows[i].id}, function(err, fileName) {  // delete the ad
								if (err) {
									log(radioName + "deleteOldTracks: could not remove fps in " + where + " id " + rows[i].id + " file " + rows[i].file_name, consts.LOG_WARN);
									f(rows, i+1);
									return;
								}
								log(radioName + " deprecate track " + rows[i].file_name + " in " + where + " id " + rows[i].id + " from radio " + rows[i].radio, consts.LOG_INFO);
								
								var renameCallback = function() {
									limit--;
									if (limit > 0) {
										f(rows, i+1);
									} else {
										callback(); // when cross removal of ads, only remove one at a time
										return;
									}
								}
								
								if (radioName == rows[i].radio) { // trash the file only if the deprecated ad was first seen on the current radio
									fs.rename("./" + where + "/" + rows[i].file_name + ".mp3", "./" + where + "_deprecated/" + rows[i].file_name + ".mp3", function(err) { // move the file to the graveyard
										if (err != null) {
											log(radioName + " deleteOldTracks: could not deprecate " + where + " file " + rows[i].file_name + " : " + err, consts.LOG_WARN);
										}
										renameCallback();
									});
								} else {
									renameCallback();
								}
							});
						}
					});
				} else {
					deleteTrack(radioName, tableName, { "id": rows[i].id }, utilDb, function(err) {
					//deleteAmongCluster(radioName, tableName, {fromId:true, id:rows[i].id}, function(err, fileName) {  // delete the ad
						if (err) {
							log(radioName + " deleteOldTracks: could not remove fps in " + where + " id " + rows[i].id + " file " + rows[i].file_name, consts.LOG_WARN)
							f(rows, i+1);
							return;
						}
						fs.unlink("./" + where + "/" + rows[i].file_name + ".mp3", function(err) { // delete the file
							if (err != null) {
								log(radioName + " deleteOldTracks: could not remove " + where + " file: " + err, consts.LOG_WARN);
							}
							f(rows, i+1);
						});
					});
				}
			}
			
			if (err) {
				log(radioName + " deleteOldTracks: could not select old " + where + ": " + err, consts.LOG_WARN);
			} else {
				//log(radioName + " going to delete " + rows.length + " candidates");
				f(rows, 0);
			}
		});
	});
}


var moveCandidate = function(radioName, id, from, destination, utilDb, callback) { // ipcCaller, 
	
	/*if (process.send && ipcCaller == consts.IPC_CALLER_WEBMIN) {
		process.send({"type": consts.IPC_MSG_MOVECANDIDATE, "data": {"stream": radioName, "id": id, "from": from, "destination": destination, "ipcCaller": ipcCaller}});
		process.once(consts.IPC_MSG_MOVECANDIDATE, function(err) {
			callback(err);
		});
	}*/
	
	var fromDir = consts.getDirFromDestination(from);
	var destinationDir = consts.getDirFromDestination(destination);
	if (!fromDir) {
		log("move request: invalid origin " + from, consts.LOG_WARN);
		callback("invalid origin");
		return;
	}
	if (!destinationDir) {
		log("move request: invalid destination " + from, consts.LOG_WARN);
		callback("invalid destination");
		return;
	}
	
	utilDb.get(radioName, function(db) {
		db.get("SELECT file_name FROM " + fromDir.dir + " WHERE id=?;", [id], function(err, row) {
			if (err != null) {
				log("sql request error (move request 1): " + err, consts.LOG_WARN);
				callback("sql error 1");
				return;
			}
			if (!row) {
				callback("id " + id + " not found");
				return;
			}
	
			var afn = row.file_name.split("_");
			var uuid = afn[3];
			if (uuid == "xx") uuid = "monitor";
			var newFileName = afn[0] + "_" + afn[1] + "_" + afn[2] + "_" + uuid;
				
			fs.rename("./" + from + "/" + row.file_name + ".mp3", "./" + destination + "/" + newFileName + ".mp3", function(err) {
				if (err && err.toString().indexOf("ENOENT: no such file or directory") >= 0) {
					log("file did not exist anymore, we remove the fingerprints");
					//deleteAmongCluster(radioName, from, {fromId:true, id:id}, utilDb, function(err, fileName) {
					deleteTrack(radioName, from, { "id": id }, utilDb, function(err, fileName) {
						if (err) {
							log("error, could not delete candidate " + err, consts.LOG_WARN);
							callback("cannot delete candidate, abort");
						} else {
							callback("file did not exist anymore, we removed the fingerprints");
						}
					});
					
				} else if (err) {
					log("error, could not move candidate file: " + err, consts.LOG_WARN);
					callback("cannot move candidate file, abort");
					
				} else if (fromDir.dir != destinationDir.dir) { // move between two different tables, or move to trash
					//deleteAmongCluster(radioName, from, {fromId:true, id:id}, utilDb, function(err, fileName) {
					deleteTrack(radioName, from, { "id": id }, utilDb, function(err, fileName) {
						if (err) {
							log("error, could not delete candidate " + err, consts.LOG_WARN);
							callback("cannot delete candidate, abort");
							return;
						}
							
						if (destination != consts.DEST_DISCARD) {  //destination != consts.DEST_ADS + "_jingles" && 
							fingerprintFile(newFileName, destination, radioName, utilDb, function() { 
								if (from == consts.DEST_MRS) {
									require("./util_cleandupes.js").removeDupes(radioName, newFileName, destination, [consts.DEST_MRS], utilDb, function() {
										callback(null); 
									});
								} else {
									callback(null);
								}
							});
						} else {
							callback(null);
						}
					});
					
				} else { // ad with change of whitelist code. the siblings dbs will update the wl code in the checkTracks routine
					db.run("UPDATE " + fromDir.dir + " SET whitelist=" + destinationDir.whitelistCode + " WHERE id=?;", [id], function(err) {
						if (err != null) {
							log("error, could not change whitelist code of ad #" + id + " from " + fromDir.whitelistCode + " to " + destinationDir.whitelistCode, consts.LOG_WARN);
							callback("cannot change whitelist code, abort");
						} else {
							log("whitelist code of ad #" + id + " changed from " + fromDir.whitelistCode + " to " + destinationDir.whitelistCode, consts.LOG_DEBUG);
							callback(null);
						}
					});
				}
			});
		});
	});
}

//var deleteCandidate = function(radioName, id, where, callback) {
//	deleteAmongCluster(radioName, where, {fromId:true, id:id}, callback);
	
/*	dbs(radioName, function(db) {
		var f = function() {
			db.run("DELETE FROM " + where + " WHERE id = ?;", id, function(err3) {
				if (err3 != null) {
					log("sql request error (delete " + where + "): " + err3, consts.LOG_WARN);
					callback("sql error 3");
					return;
				}
				//log("delete OK", consts.LOG_INFO);
				callback(null);
			});
		}
		
		if (where == consts.DEST_ADS || where == consts.DEST_CANDIDATES || where == consts.DEST_MRS) {
		
			db.run("DELETE FROM " + where + "_fingers WHERE ad = ?;", id, function(err2) {
				if (err2 != null) {
					log("sql request error (delete fingers): " + err2, consts.LOG_WARN);
					callback("sql error 2");
					return;
				}
				f();
			});
		} else {
			f();
		}


	});
}*/

var insertHistory = function(radioName, type, date, ref, adlevel, utilDb, callback) {

	if (!consts.getDirFromDestination(type)) {
		log("error, wrong destination: " + type + " (insertHistory)", consts.LOG_WARN);
		callback("wrong destination");
		return;
	}

	utilDb.get(radioName, function(db) {
		if (db == null) {
			log(consts.paddedRadioName(radioName) + " could not find db to save ad history", consts.LOG_WARN);
			callback("db not found");
			return;
		}
		db.run("INSERT INTO history_" + type + " (date, radio_id, ad_id, adlevel) VALUES (?,?,?,?)", [date, 0, ref, Math.round(adlevel*10)/10], function(err) {
			if (err) {
				log("error inserting into " + type + " history : " + err, consts.LOG_WARN);
			}
			callback(null);
		});
	});
}

var clearMetadata = function(radioName, utilDb, callback) {
	utilDb.get(radioName, function(db) {
		if (db == null) {
			log(consts.paddedRadioName(radioName) + " could not find db to save ad history", consts.LOG_WARN);
			callback("db not found");
			return;
		}
		db.run("UPDATE history_metadata SET status=NULL WHERE status='pending'", function(err) {
			if (err) {
				log("problem clearing metadata pending for radio " + radioName + " -- " + err, consts.LOG_WARN);
				callback("could not clear metadata for radio " + radioName + ": " + err);
			} else {
				callback(null);
			}	
		});
	});
}

exports.getSiblings = getSiblings;
//exports.checkAmongCluster = checkAmongCluster;
exports.checkTrack = checkTrack;
exports.saveTrack = saveTrack;
//exports.saveAmongCluster = saveAmongCluster;
//exports.deleteAmongCluster = deleteAmongCluster;
exports.deleteTrack = deleteTrack;
exports.deleteOldTracks = deleteOldTracks;
exports.moveCandidate = moveCandidate;
exports.insertHistory = insertHistory;
exports.clearMetadata = clearMetadata;
exports.fingerprintDirectory = fingerprintDirectory;
