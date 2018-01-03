var consts = require("./util_consts");
var log = consts.log("mrs");

var DEBUG = false;
var sampling = 11025;
var segment_duration = consts.FLAG_DT_PRE + consts.FLAG_DT_POST;

var mrsDsp = require("./mrs_dsp.js");
var mrsIo = require("./mrs_io.js");
var utilDb = require("./util_db.js");

var setDebugMode = function() {
	DEBUG = true;
	mrsDsp.setDebugMode();
	mrsIo.setDebugMode();
}

// maximum repeated sequences (MRS) among candidates.


var getCommonAudio = function(radioName, rowsById, sequence, expandDirections, utilDb, callback) {
	if (DEBUG) log(require("util").inspect(sequence));
	mrsIo.loadFpBatch(radioName, rowsById, sequence.froms.concat(sequence.tos), utilDb, function(err) {
		if (err) {
			log(radioName + " getCommonAudio: warning, error : " + err, consts.LOG_ERROR);
			callback(err, null);
			return;
		}
					
		var statusContinuity = mrsIo.checkContinuity(rowsById, sequence.froms, sequence.tos, segment_duration);
		if (statusContinuity) {
			callback(statusContinuity, null);
			return;
		}
					
		if (sequence.froms.length == 3 && sequence.tos.length == 3) {
			var btsp = mrsDsp.bootstrapComparison(radioName, rowsById, sequence.froms[1], sequence.tos[1]);
			if (DEBUG) log(radioName + " bootstrap result: t1=" + btsp.t1 + " t2=" + btsp.t2 + " diff=" + btsp.diff);
			sequence.init2 = { "start": segment_duration * sampling + btsp.t1*consts.FINGERS_DT*sampling, "stop": segment_duration * sampling + btsp.t2*consts.FINGERS_DT*sampling };
			sequence.init1 = { "start": segment_duration * sampling + (btsp.t1-btsp.diff)*consts.FINGERS_DT*sampling, "stop": segment_duration * sampling + (btsp.t2-btsp.diff)*consts.FINGERS_DT*sampling };
		}
					
		// decode
		mrsDsp.decode(rowsById, sequence.froms, sampling, function(err, fromAudio) {
			if (err) {
				callback("decoding sequence 'from' error: " + err, sequence);
				return;
			}
			
			if (DEBUG) log(radioName + " from audio: " + fromAudio.length + " bytes");
			mrsDsp.decode(rowsById, sequence.tos, sampling, function(err, toAudio) {
				if (err) {
					callback("decoding sequence 'to' error: " + err, sequence);
					return;
				}				
				if (DEBUG) log(radioName + " to audio: " + toAudio.length + " bytes");
				
				var result = mrsDsp.detectXcorrSteps(fromAudio, toAudio, sequence.init1, sequence.init2, expandDirections, sampling);
				if (DEBUG) log(radioName + " xcorrsteps result: t1=" + sequence.init2.start + " t2=" + sequence.init2.stop + " max=" + (toAudio.length/2));
				if (result.err) {
					callback(result.err, null);
					return;
				}
					
				if (result.expandDirections) {
					if (DEBUG) log(radioName + " expansion required for directions " + result.expandDirections);
					
					if (result.expandDirections.indexOf("L") >= 0) {
						sequence.froms = [sequence.froms[0]-1].concat(sequence.froms);
						sequence.tos = [sequence.tos[0]-1].concat(sequence.tos);
						sequence.init1.start += segment_duration * sampling;
						sequence.init2.start += segment_duration * sampling;
						sequence.init1.stop += segment_duration * sampling;
						sequence.init2.stop += segment_duration * sampling;
					}
					if (result.expandDirections.indexOf("R") >= 0) {
						sequence.froms.push(sequence.froms[sequence.froms.length-1]+1);
						sequence.tos.push(sequence.tos[sequence.tos.length-1]+1);
					}
					if (sequence.froms.length * segment_duration <= consts.MRS_MAX_LENGTH) {
						getCommonAudio(radioName, rowsById, sequence, result.expandDirections, utilDb, callback);
					} else {
						callback("sequence too long, ignored", sequence);
					}
					return;
				
				} else {
					if ((sequence.init2.stop - sequence.init2.start) / sampling >= consts.MRS_MIN_LENGTH) {
						callback(null, sequence);
					} else {
						callback("sequence too short: " + Math.round(((sequence.init2.stop - sequence.init2.start) / sampling)*100)/100, null);
					}
					return;
				}
			});
		});
	});
}


var main = function(radioName, t1, t2, masterCallback) {

	log(radioName + " analysing candidates between t1=" + t1.toISOString() + " & t2=" + t2.toISOString(), consts.LOG_INFO);

	mrsIo.getLinks(radioName, t1, t2, utilDb, function(rowsById, links) {
			
		var f = function(links, il, callback) {
			if (il >= links.length) {
				callback();
				return;
			} else if (links[il].from == -1 || links[il].to == -1) {
				f(links, il+1, callback);
				return;
			} else if (Math.abs(links[il].from-links[il].to)*(consts.FLAG_DT_PRE+consts.FLAG_DT_POST) < consts.MRS_MIN_DELTA) {
				log(radioName + " link " + il + "/" + links.length + " ignored because two segments are too close. from=" + links[il].from + " to=" + links[il].to, consts.LOG_INFO);
				f(links, il+1, callback);
				return;	
			}
			//log("link " + il + "/" + links.length + " from " + links[il].from + " to " + links[il].to, consts.LOG_INFO);
			
			getCommonAudio(radioName, rowsById, { "froms": [links[il].from-1, links[il].from, links[il].from+1], "tos": [links[il].to-1, links[il].to, links[il].to+1] }, "LR", utilDb, function(err, result) {
				
				var removeDuplicates = function() {
					// remove links in the list that would lead to a duplicate result.
					for (var i=il+1; i<links.length; i++) {
						if ((links[i].from >= result.froms[0] && links[i].from <= result.froms[result.froms.length-1]) || (links[i].to >= result.tos[0] && links[i].to <= result.tos[result.tos.length-1])) {
							if (DEBUG) log(radioName + " link " + i + " with bounds " + links[i].from + "-" + links[i].to + " will be ignored", consts.LOG_DEBUG);
							links[i].from = -1;
							links[i].to = -1;
						}
					}
				}
				
				if (err) {
					log(radioName + " link " + il + "/" + links.length + " ignored because: " + err, consts.LOG_WARN);
					if (result) removeDuplicates();
					f(links, il+1, callback);
					return;
				}
								
				if (DEBUG) {
					log("mrs obtained: start at " + (result.init1.start / sampling) + " in " + rowsById[result.froms[0]].file_name, consts.LOG_DEBUG);
					log("               stop at " + (result.init1.stop / sampling) + " in " + rowsById[result.froms[result.froms.length-1]].file_name, consts.LOG_DEBUG);
					log("              start at " + (result.init2.start / sampling) + " in " + rowsById[result.tos[0]].file_name, consts.LOG_DEBUG);
					log("               stop at " + (result.init2.stop / sampling) + " in " + rowsById[result.tos[result.tos.length-1]].file_name, consts.LOG_DEBUG);
				}
				
				removeDuplicates();
				
				var mrsDate = new Date(rowsById[result.tos[0]].flag_date);
				mrsDate = (new Date(+mrsDate + result.init1.start / sampling * 1000)).toISOString();
				var fileName = mrsDate + "_" + radioName + "_monitor-mrs";
				var ratioStart = result.init2.start / sampling / result.tos.length / segment_duration; 
				var ratioStop  = result.init2.stop  / sampling / result.tos.length / segment_duration;
				var duration = Math.round((result.init2.stop-result.init2.start)/sampling*100)/100;
				
				mrsIo.generateAudioFile(rowsById, result.tos, ratioStart, ratioStop, "mrs/" + fileName + ".mp3", function(err) {
					if (err) {
						log(radioName + " link " + il + "/" + links.length + " error generating audio file : " + err, consts.LOG_ERROR);
						f(links, il+1, callback);
						return;
					} else {
						log(radioName + " link " + il + "/" + links.length + " mrs audio file generated: " + fileName + " length " + duration, consts.LOG_INFO);
					}
				
					/*var mrsDate = new Date(rowsById[result.froms[0]].flag_date);
					mrsDate = (new Date(+mrsDate + result.init2.start / sampling * 1000)).toISOString();
					var fileName = mrsDate + "_" + radioName + "_monitor-mrs";
					var ratioStart = result.init1.start / sampling / result.tos.length / segment_duration; 
					var ratioStop  = result.init1.stop  / sampling / result.tos.length / segment_duration;
					var duration = Math.round((result.init1.stop-result.init1.start)/sampling*100)/100;
				
					mrsIo.generateAudioFile(rowsById, result.froms, ratioStart, ratioStop, "mrs/" + fileName + ".mp3", function(err) {*/
					
					var Stream = require("./analyser_stream.js");
					var fingerprintFile = function(fileName, utilDb, callback) {
						var options = { "adFileName":fileName, "directory": consts.DEST_MRS, "duration": duration, "utilDb": utilDb, "callback": function(fpObj) { delete dummyStream; callback(fpObj) } };
						var dummyStream = new Stream("dummy_fingerprint_this", options);
					}
					
					fingerprintFile(fileName, utilDb, function(fpObj) {
					
						// given fingerprints, now look for duplicates.
						mrsIo.compareMrs(radioName, fileName, fpObj.tFP, fpObj.hFP, utilDb, function(err) {
							f(links, il+1, callback);
						});
					});
					
					/*});*/
				});
			});
		}
			
		//links = links.slice(0,20);
		//links = [links[17]];
		//links = [links[224]];
		//links = links.slice(48, links.length);
		f(links, 0, function() {
			
			//log("done", consts.LOG_INFO);
			masterCallback();
		});
			
			
	});
}

//log(process.argv);
var path = process.argv[1].split("/");
if (process.argv.length >= 5 && path[path.length-1] == "mrs.js") {
	//log("Wrong syntax. Usage: nodejs analyser_mrs [radio] [t1] [t2]", consts.LOG_ERROR);
	//return;

	if (process.argv.indexOf("--dev") >= 0) setDebugMode();
	if (DEBUG) log("starting mrs analyser on the command line", consts.LOG_INFO);
	var radioName = process.argv[2];
	var t1 = new Date(process.argv[3]);
	var t2 = new Date(process.argv[4]);
	main(radioName, t1, t2, function() {
		if (DEBUG) log("job done");
		//setTimeout(process.exit, 2000);
		process.exit(0);
	});
}

module.exports = main;
