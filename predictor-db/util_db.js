var consts = require("./util_consts");
var log = consts.log("util/sqlite");

var sqlite3 = require("sqlite3").verbose();
//var dbsGlob = new sqlite3.Database("./sqlite/analyser.sqlite"); // dbs for db sqlite
var dbList = new Object();
/*var dbsUsers = new sqlite3.Database("./sqlite/users.sqlite");

var initUsersDb = function() {
	dbsUsers.run("CREATE TABLE IF NOT EXISTS `users` (`uuid` TEXT, `reg_ip` TEXT, `reg_date` TEXT, `user_agent` TEXT, `lang` TEXT, PRIMARY KEY(uuid) )", function(err) {
	dbsUsers.run("CREATE TABLE IF NOT EXISTS `recipes` (`uuid` TEXT, `recipe` TEXT, `date` TEXT, `played_time` INTEGER )", function(err) {
	dbsUsers.run("CREATE TABLE IF NOT EXISTS 'flags' (`id` INTEGER, `radio` TEXT, `date` TEXT, `uuid` TEXT, `reputationGain` INTEGER, `status` INTEGER, PRIMARY KEY(id) )", function(err) {
	dbsUsers.run("CREATE TABLE IF NOT EXISTS `feedbacks` (`id` INTEGER, `date` TEXT, `satisfied` INTEGER, `text` TEXT, `email` TEXT, `uuid` TEXT, PRIMARY KEY(id) )", function(err) {
		//callback(dbsUsers);
	});	});	}); });
}
initUsersDb();*/

var initDb = function(db, callback) {

	db.run("PRAGMA auto_vacuum = '0'", function(err) {
	db.run("PRAGMA automatic_index = '1'", function(err) {
	db.run("PRAGMA checkpoint_fullfsync = '0'", function(err) {
	db.run("PRAGMA foreign_keys = '1'", function(err) {
	db.run("PRAGMA fullfsync = '0'", function(err) {
	db.run("PRAGMA ignore_check_constraints = '0'", function(err) {
	db.run("PRAGMA journal_mode = 'wal'", function(err) {
	db.run("PRAGMA journal_size_limit = '-1'", function(err) {
	db.run("PRAGMA locking_mode = 'normal'", function(err) {
	db.run("PRAGMA max_page_count = '1073741823'", function(err) {
	db.run("PRAGMA page_size = '1024'", function(err) {
	db.run("PRAGMA recursive_triggers = '0'", function(err) {
	db.run("PRAGMA secure_delete = '1'", function(err) {
	db.run("PRAGMA synchronous = '1'", function(err) {
	db.run("PRAGMA temp_store = '0'", function(err) {
	db.run("PRAGMA user_version = '0'", function(err) {
	db.run("PRAGMA wal_autocheckpoint = '1000'", function(err) {
	db.run("PRAGMA wal_checkpoint(TRUNCATE);", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'ads' ( `id` INTEGER, `radio` TEXT, `file_name` TEXT, `flag_uuid` TEXT, `flag_date` TEXT, `duration` INTEGER, `fingerprints` INTEGER, `whitelist` INTEGER DEFAULT 0, PRIMARY KEY(id) )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'ads_fingers' (`finger` INTEGER NOT NULL, `ad` INTEGER NOT NULL, `dt` INTEGER NOT NULL, FOREIGN KEY(`ad`) REFERENCES ads(id) )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'candidates' (`id` INTEGER, `radio` TEXT, `file_name` TEXT, `flag_date` TEXT, `duration` INTEGER DEFAULT 0, `fingerprints` INTEGER, `paired_with` INTEGER, `last_meta` TEXT, PRIMARY KEY(id) )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'candidates_fingers' (`finger` INTEGER NOT NULL, `ad` INTEGER NOT NULL, `dt` INTEGER NOT NULL, FOREIGN KEY(`ad`) REFERENCES candidates(id) )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'musics' (`id` INTEGER, `radio` TEXT, `file_name` TEXT, `date` TEXT, `duration` INTEGER, `fingerprints` INTEGER, PRIMARY KEY(id) )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'musics_fingers' (`finger` INTEGER NOT NULL, `ad` INTEGER NOT NULL, `dt` INTEGER NOT NULL, FOREIGN KEY(`ad`) REFERENCES musics(id) )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'history_ads' (`date` TEXT NOT NULL, `radio_id` INTEGER NOT NULL, `ad_id` INTEGER NOT NULL, `adlevel` INTEGER NOT NULL )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'history_metadata' (`radio`	INTEGER, `metadata` TEXT, `firstseen` TEXT, `lastseen` TEXT, `count` INTEGER, `status` INTEGER )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'history_musics' (`date` TEXT NOT NULL, `radio_id` INTEGER NOT NULL, `ad_id` INTEGER NOT NULL, `adlevel` INTEGER NOT NULL )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'mrs' (`id` INTEGER, `radio` TEXT, `file_name` TEXT, `date` TEXT, `duration` INTEGER, `fingerprints` INTEGER, `paired_with` INTEGER, `prop1` INTEGER, `prop2` INTEGER, `prop3` INTEGER, `prop4` INTEGER, PRIMARY KEY(id) )", function(err) {

	db.run("CREATE TABLE IF NOT EXISTS 'mrs_fingers' (`finger` INTEGER NOT NULL, `ad` INTEGER NOT NULL, `dt` INTEGER NOT NULL, FOREIGN KEY(`ad`) REFERENCES mrs(id) )", function(err) {

	db.run("CREATE INDEX IF NOT EXISTS AdsFingersIndex ON ads_fingers (finger)", function(err) {

	db.run("CREATE INDEX IF NOT EXISTS CandidatesFingersIndex ON candidates_fingers (finger)", function(err) {

	db.run("CREATE INDEX IF NOT EXISTS MusicsFingersIndex ON musics_fingers (finger)", function(err) {

	db.run("CREATE INDEX IF NOT EXISTS MrsFingersIndex ON mrs_fingers (finger)", function(err) {

	db.configure("busyTimeout", 10000);

			callback();
	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});	});
}

/*var get = function(dbName, callback) {

	if (dbName == "glob") {
		return dbsGlob;
	} else if (dbName == "users") {
		return dbsUsers;
	} else if (dbList[dbName]) {
		callback(dbList[dbName]);
		return;
	} else {
		// check that the requested db is in the radio list
		dbsGlob.get("SELECT code FROM radio WHERE code = ?", dbName, function(err, row) {
			if (err) {
				log("WARNING, problem checking the validity of db request. " + err, consts.LOG_WARN);
				callback(null);
				return;
			}
			if (!row) {
				log("WARNING, db not matching any radio with id " + dbName, consts.LOG_WARN);
				callback(null);
				return;
			}

			var dbs = new sqlite3.Database("./sqlite/" + dbName + ".sqlite"); // dbs for db sqlite
			log("initialize db " + dbName, consts.LOG_INFO);
			//emptyDB(dbs, consts.DEST_ADS); // for testing purposes
			//removeJingles(dbs);
			initDb(dbs, function() {
				dbList[dbName] = dbs;
				callback(dbList[dbName]);
				return;
			});
		});
	}
}*/

/*var getList = function(callback) {
	dbsGlob.all("SELECT code FROM radio WHERE monitored = 1;", function(err, rows) {
		if (err) {
			log("WARNING, problem getting the list of radios. " + err, consts.LOG_WARN);
			callback(null);
			return;
		}
		var result = [];
		for (var i=0; i<rows.length; i++) {
			result.push(rows[i].code);
		}
		callback(result);
	});
}*/

var emptyDB = function(db, tableprefix) {
	db.run("DELETE FROM " + tableprefix + "_fingers;");
	db.run("DELETE FROM " + tableprefix + ";");
}

var removeJingles = function(db) {
	db.run("DELETE FROM ads_fingers WHERE ad in (SELECT ad FROM ads_fingers INNER JOIN ads ON (ads.id = ads_fingers.ad) WHERE ads.whitelist > 0 )");
	db.run("DELETE FROM ads WHERE whitelist > 0");
}


var lookForFingerprintsInDbOld = function(tFP, hFP, dbname, radioName, lookupTimeout, notEqualItem, callback) {
	// now I haz fingerprints, store them in queue array. MEOW
	var admatches = new Array(hFP.length);
	for (var i=0, limit=hFP.length; i<limit; i++) {
		admatches[i] = [];
	}
	var adlookups = 0;
	var whitelistRows = [];
	var query = "";

	// look for fingerprints in database
	if (hFP.length == 0) {
		//log(stream.padded_radio_name + "WARNING, segment had no fingerprints");
		callback(admatches);
		return;
	}

	var look = function(i, concurrentReads, db){
		db.all(query, hFP[i], function(err, rows) {
			if (err) {
				log(radioName + " warning, sqlite error during lookup: " + err, consts.LOG_WARN);
			}
			admatches[i] = rows;
			adlookups++;
			//log("fingerprint #" + i + " has " + rows.length + " matches in DB (" + adlookups + "/" + hFP.length + ")");
			if (adlookups >= hFP.length) { // once all db requests are done
				var dt = new Date() - startDate;
				log("db lookup took " + dt + " ms, so " + Math.round(1000*hFP.length/dt) + " lookups/s");
				clearTimeout(timer);
				if (!timeoutExceeded) callback(admatches);
			} else if (i+concurrentReads < hFP.length) {
				look(i+concurrentReads, concurrentReads, db);
			}
		});
	}

	var timeoutExceeded = false;
	var timer = setTimeout(function() {
		timeoutExceeded = true;
		log(radioName + " WARNING, lookups in db " + dbname + " were longer than usual. Cut the queries at " + adlookups + "/" + hFP.length + " for t=" + lookupTimeout + " ms", consts.LOG_WARN);
		callback(admatches);
	}, lookupTimeout);
	var startDate = new Date();
	var concurrentReads = 8; // setting this value too high will cause lost queries. too low and it will be slow as fuck.

	if (dbname == consts.DEST_ADS) {
		query = "SELECT ad, dt, ads.whitelist FROM " + dbname + "_fingers INNER JOIN ads ON ads_fingers.ad = ads.id WHERE finger = ?;";
	} else if (dbname == consts.DEST_CANDIDATES || dbname == consts.DEST_MUSICS || dbname == consts.DEST_MRS) {
		query = "SELECT ad, dt FROM " + dbname + "_fingers WHERE finger = ?" + (notEqualItem ? " AND ad != " + notEqualItem : "") + ";";
	}
	get(radioName, function(db) {
		for (var i=0,limit=Math.min(hFP.length,concurrentReads); i<limit; i++) {
			//log("fingerprint #" + i + " query");
			look(i, concurrentReads, db);
		}
	});
}


var lookForFingerprintsInDb = function(tFP, hFP, dbname, radioName, lookupTimeout, notEqualItem, callback) {
	// now I haz fingerprints, store them in queue array. MEOW
	var admatches = new Array(hFP.length);
	for (var i=0, limit=hFP.length; i<limit; i++) {
		admatches[i] = [];
	}
	var adlookups = 0;
	var whitelistRows = [];
	var query = "";

	// look for fingerprints in database
	if (hFP.length == 0) {
		//log(stream.padded_radio_name + "WARNING, segment had no fingerprints");
		callback(admatches);
		return;
	}

	var look = function(i, db){
		var queryArray = [];
		for (var iba=0; iba<batchReads; iba++) {
			if (i+iba < hFP.length) {
				queryArray.push(hFP[i+iba]);
			} else {
				queryArray.push(-1);
			}
		}

		db.all(query, queryArray, function(err, rows) {
			if (err || !rows) {
				log(radioName + " warning, sqlite error during lookup: " + err + " query=" + query + " queryArray=" + queryArray, consts.LOG_WARN);
			} else {
				//log("lookup in " + dbname + " : " + rows.length + " results");
				for (var iba=0; iba<batchReads; iba++) {
					for (var irow=0; irow<rows.length; irow++) {
						if (i+iba < hFP.length && hFP[i+iba] == rows[irow].finger) {
							admatches[i+iba].push(rows[irow]);
						}
					}
				}
			}
			//admatches[i] = rows;
			adlookups+=batchReads;
			//log("fingerprint #" + i + " has " + rows.length + " matches in DB (" + adlookups + "/" + hFP.length + ")");
			if (adlookups >= hFP.length) { // once all db requests are done
				var dt = new Date() - startDate;
				//log("db lookup took " + dt + " ms, so " + Math.round(1000*hFP.length/dt) + " lookups/s");
				clearTimeout(timer);
				if (!timeoutExceeded) callback(admatches);
			} else { //if (i+concurrentReads < hFP.length) {
				look(i+batchReads, db);
			}
		});
	}

	var timeoutExceeded = false;
	var timer = setTimeout(function() {
		timeoutExceeded = true;
		log(radioName + " WARNING, lookups in db " + dbname + " were longer than usual. Cut the queries at " + adlookups + "/" + hFP.length + " for t=" + lookupTimeout + " ms", consts.LOG_WARN);
		callback(admatches);
	}, lookupTimeout);
	var startDate = new Date();
	var batchReads = 40; // setting this value too high will cause lost queries. too low and it will be slow as fuck.

	var inStr = "(";
	for (var i=0; i<batchReads-1; i++) {
		inStr += "?,";
	}
	inStr += "?)";

	if (dbname == consts.DEST_ADS) {
		query = "SELECT ad, dt, finger, ads.whitelist FROM " + dbname + "_fingers INNER JOIN ads ON ads_fingers.ad = ads.id WHERE finger IN " + inStr + ";";
	} else if (dbname == consts.DEST_CANDIDATES || dbname == consts.DEST_MUSICS || dbname == consts.DEST_MRS) {
		query = "SELECT ad, dt, finger FROM " + dbname + "_fingers WHERE finger IN " + inStr + (notEqualItem ? " AND ad != " + notEqualItem : "") + ";";
	}
	get(radioName, function(db) {
		//for (var i=0,limit=Math.min(hFP.length,concurrentReads); i<limit; i++) {
			//log("fingerprint #" + i + " query");
			look(0, db);
		//}
	});
}




exports.get = get;
exports.emptyDB = emptyDB;
exports.getList = getList;
exports.lookForFingerprintsInDb = lookForFingerprintsInDb;
