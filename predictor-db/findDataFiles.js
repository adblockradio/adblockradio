var fs = require("fs");
var log = require("loglevel");
log.setLevel("debug");
var async = require("async");
var consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "9-unsure", "mrs", "todo"]
}

var getDirs = function(rootDir, cb) {
	fs.readdir(rootDir, function(err, files) {
		var dirs = [];
		if (err) {
			log.warn("getDirs: readdir error for " + rootDir + " err=" + err);
			return cb(dirs);
		}
		//log.debug("getDirs: files found in " + rootDir + " : " + files);

		var f = function(i, callback) {
			if (i >= files.length) return callback();

			var filePath = rootDir + '/' + files[i];
			fs.stat(filePath, function(err, stat) {
				if (err) {
					log.warn("getDirs: stat error for " + filePath + " err=" + err);
				}
				if (stat.isDirectory()) {
					dirs.push(files[i]);
				}
				f(i+1, callback);
			});
		}

		f(0, function() {
			return cb(dirs);
		});
	});
}

var getFiles = function(path, after, before, cb) {
	fs.readdir(path, function (err, files) {
		if (err) {
			log.warn("error listing files in path " + path + ". err=" + err);
			return cb([]);
		}
		var list = {};

		// only get files that have good date
		for (var i=files.length-1; i>=0; i--) {
			if ((after && files[i] < after) || // file names begin by ISO dates (24 characters)
				(before && files[i] > before)) {
				//log.debug("getFiles: remove " + files[i]);
				files.splice(i, 1);
			} else {
				var spf = files[i].split("Z."); // end of the ISO date
				if (spf.length != 2) log.warn("getFiles: malformed file: " + files[i]);
				var path1 = path + "/" + spf[0] + "Z";
				if (!list[path1]) {
					var ps = path.split("/");
					list[path1] = { class: ps[ps.length-1] };
				}
				list[path1][spf[1]] = true;
			}
		}
		cb(list);
	});
}

// finds all files in the subdirectory structure
// options: {
//   radios: [country1_name1, country2_name2, ...] OR country: ... name: ...
//   before/after: ISO Date, e.g. new Date().toISOString()
//   path: __dirname/records/DATE/RADIO/CLASS/ISODATE.*
// }
var findDataFiles = function(options, callback) {
	var targetRadios = (options && options.radios) ? options.radios : [options.country + "_" + options.name];
	var timeFrame = {
		after: (options && options.after) ? options.after : null,
		before: (options && options.before) ? options.before : null
	};

	var files = new Object();
	for (let i=0; i<consts.WLARRAY.length; i++) {
		files[consts.WLARRAY[i]] = {};
	}

	getDirs(options.path + "/records", function(dateDirs) {
		for (let i=dateDirs.length-1; i>=0; i--) {
			if (timeFrame.after && dateDirs[i] < timeFrame.after) dateDirs.splice(i, 1);
			if (timeFrame.before && dateDirs[i] > timeFrame.before) dateDirs.splice(i, 1);
		}

		async.forEachOf(dateDirs, function(dateDir, index, dateDirCallback) {
			getDirs(options.path + "/records/" + dateDir, function(radioDirs) {
				//log.debug("findDataFiles: radioDirs before = " + radioDirs);
				for (let i=radioDirs.length-1; i>=0; i--) {
					if (targetRadios.indexOf(radioDirs[i]) < 0) radioDirs.splice(i, 1);
				}
				//log.debug("findDataFiles: radioDirs after = " + radioDirs);

				async.forEachOf(radioDirs, function(radioDir, index, radioDirCallback) {
					async.forEachOf(consts.WLARRAY, function(dataDir, index, dataDirCallback) {
						var path = options.path + "/records/" + dateDir + "/" + radioDir + "/" + dataDir;
						fs.stat(path, function(err, stat) {
							if (stat && stat.isDirectory()) {
								getFiles(path, timeFrame.after, timeFrame.before, function(partialFiles) {
									//log.debug("findDataFiles: " + dataDir + ":" + partialFiles);
									Object.assign(files[dataDir], partialFiles); // = files[dataDir].concat(fullPathFiles);
									dataDirCallback();
								});
							} else {
								dataDirCallback();
							}
						});

					}, function(err) {
						if (err) log.error("findDataFiles: pb during data dir listing. err=" + err.message);
						radioDirCallback();
					});

				}, function(err) {
					if (err) log.error("findDataFiles: pb during radio dir listing. err=" + err.message);
					dateDirCallback();
				});
			});

		}, function(err) {
			if (err) log.error("findDataFiles: pb during date dir listing. err=" + err.message);
			callback(files);
		});
	});
}

module.exports = findDataFiles;
