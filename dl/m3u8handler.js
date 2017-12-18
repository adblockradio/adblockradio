var log = require("loglevel"); //("mls/m3u8handler", true);
log.setLevel(0);
var m3u8 = require("m3u8");
//var m3u8stream = require("m3u8stream"); // that was buggy when tested
var http = require("http");
var https = require("https");
var url = require("url");
var fs = require("fs");
var cp = require('child_process');

var timeStamp = null;
const EMIT_INTERVAL = 2;

var parseIntParameter = function(data, name) {
	var p1 = data.indexOf(name) + name.length;
	var p2 = data.slice(p1).indexOf("\n");
	return parseInt(data.slice(p1, p1 + p2));
}

var remainingData = null;
var incrementalTimeoutHandle = null;

var incrementalEmitter = function(size, delay, origin, emitter) {
	//log.debug("incrementalEmitter: send " + size + " bytes to analyser " + origin.segment + ":" + origin.substep);
	emitter(remainingData.slice(0, size), delay);
	remainingData = remainingData.slice(size);
	if (remainingData.length == 0) return;
	origin.substep += 1;
	incrementalTimeoutHandle = setTimeout(function() {
		incrementalEmitter(size, delay, origin, emitter);
	}, EMIT_INTERVAL * 1000); //delay * 1000 / DELAY_FRACTION);
}

var parsePlaylist = function(playlistUrl, lastSegment, localTimeStamp, callback) {
	//console.log("get playlist given last segment=" + lastSegment);
	if (timeStamp !== localTimeStamp) return log.warn("timestamp mismatch. hls download aborted");
	(url.parse(playlistUrl).protocol == "http:" ? http : https).get(playlistUrl, function (res) {
		var playlist = "";
		res.on("data", function(data) {
			playlist += data;
		});
		res.on("end", function() {
			// now playlist is ready to be processed
			var delay = parseIntParameter(playlist, "#EXT-X-TARGETDURATION:");
			var sequence = parseIntParameter(playlist, "#EXT-X-MEDIA-SEQUENCE:");
			//console.log("playlist delay=" + delay + " sequence=" + sequence);
			var initialBuffer = false;
			if (lastSegment == -1) {
				initialBuffer = true;
				lastSegment = sequence - 2; // will dl the second to last segment
			} else if (lastSegment < sequence - 5 || lastSegment > sequence) {
				lastSegment = sequence - 1; // will dl the last segment
			}

			var lines = playlist.split("\n");
			var segmentUrl = null;

			/*if (initialBuffer) {
				for (var i=0; i<lines.length; i++) {
					if (lines[i].slice(0, 7) === "http://") {
						segmentUrl = lines[i];
						break;
					}
				}
			} else {*/
			// download the (sequence - lastSegment) last item of the playlist, then refresh
			var urlsToIgnore = sequence - 1 - lastSegment;

			for (var i=lines.length-1; i>=0; i--) {
				if (lines[i].slice(0, 7) === "http://" || lines[i].slice(lines[i].length-3, lines[i].length) == ".ts") {
					if (urlsToIgnore > 0) {
						urlsToIgnore--;
					} else if (urlsToIgnore == 0) {
						segmentUrl = lines[i];
						break;
					}
				}
			}
			//}

			if (segmentUrl) {
				//log.debug("get " + segmentUrl);
				if (segmentUrl.indexOf("://") < 0) {
					//console.log("playlistUrl=" + playlistUrl);
					var playlistUrlSplit = playlistUrl.split("/");
					playlistUrlSplit[playlistUrlSplit.length-1] = segmentUrl;
					//log.info("uri " + segmentUrl + " completed with path is " + playlistUrlSplit.join("/"));
					segmentUrl = playlistUrlSplit.join("/");
				}
				(url.parse(segmentUrl).protocol == "http:" ? http : https).get(segmentUrl, function(res) {
					var hlsData = null;
					var converter = cp.spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-acodec', 'copy', '-v', 'fatal', '-f', 'adts', 'pipe:1'], { stdio: ['pipe', 'pipe', process.stderr] });
					res.pipe(converter.stdin);
					converter.stdout.on("data", function(data) {
						//log.debug("ffmpeg sent " + data.length + " bytes");
						hlsData = (hlsData ? Buffer.concat([hlsData, data]) : new Buffer(data))
					});
					//res.on("end", function() {
					converter.stdout.on("end", function() {
						if (remainingData && remainingData.length > 0) {
							log.debug("prematurely flushing " + remainingData.length + " from buffer");
							clearTimeout(incrementalTimeoutHandle);
							incrementalEmitter(remainingData.length, delay, { segment: lastSegment-1, substep: 99 }, callback);
						}
						if (!hlsData || !hlsData.length) {
							log.warn("empty data after extraction from container");
							return;
						}
						remainingData = hlsData;
						if (initialBuffer || EMIT_INTERVAL >= delay) { //if EMIT_INTERVAL is bigger than delay, sends everything at once
							incrementalEmitter(hlsData.length, delay, { segment: lastSegment, substep: 0 }, callback);
						} else { // if EMIT_INTERVAL is smaller	than delay, sends in steps.
							var nSteps = Math.ceil(delay / EMIT_INTERVAL); // >= 2
							incrementalEmitter(Math.ceil(hlsData.length / nSteps), delay, { segment: lastSegment, substep: 0 }, callback);
						}
					});
				});
				lastSegment += 1;
			}
			setTimeout(function() { parsePlaylist(playlistUrl, lastSegment, localTimeStamp, callback)}, delay / 4 * 1000)
		});
	});
}


var parseMaster = function(masterUrl, callback) {
	var parser = m3u8.createStream();

	var file = (url.parse(masterUrl).protocol == "http:" ? http : https).get(masterUrl, function (res) {
		res.on("data", function(data) {
			parser.write(data);
		});
		res.on("end", function() {
			parser.end();
		});
	});

	const M3U8_TARGET_BANDWIDTH = 128000;

	parser.on('m3u', function(m3u) {
		//console.log("m3u: " + ); //toString());
		var nStreams = m3u.items.StreamItem.length;

		var iTargetBandwidth = 0;
		var selectedBandwidth = 0;
		var selectedUri = "";
		for (var i=0; i<nStreams; i++) {
			var bandwidth = m3u.items.StreamItem[i].get("bandwidth");
			var uri = m3u.items.StreamItem[i].get("uri");
			//console.log("stream " + i + " has bw=" + bandwidth + " and uri=" + uri);
			// choose the stream whose bandwidth is the closest from the target
			if (Math.abs(bandwidth - M3U8_TARGET_BANDWIDTH) <
				Math.abs(m3u.items.StreamItem[iTargetBandwidth].get("bandwidth") - M3U8_TARGET_BANDWIDTH)) {
				iTargetBandwidth = i;
				selectedBandwidth = bandwidth;
				selectedUri = uri;
			}
		}
		log.info("selected stream is #" + iTargetBandwidth + " at " + selectedBandwidth + "bps and uri=" + selectedUri);
		if (selectedUri.indexOf("://") < 0) {
			console.log("masterUrl=" + url.format(masterUrl));
			var mstSplit = url.format(masterUrl).split("/");
			mstSplit[mstSplit.length-1] = selectedUri;
			log.info("uri " + selectedUri + " completed with path is " + mstSplit.join("/"));
			return callback(mstSplit.join("/"));
		} else {
			return callback(selectedUri);
		}
	});
}

module.exports = function(masterUrl, dataCallback) {
	timeStamp = new Date(); // timeStamp helps having maximum one download at the same time.
	parseMaster(masterUrl, function(playlistUrl) {
		parsePlaylist(playlistUrl, -1, timeStamp, function(data) {
			return dataCallback(data);
		});
	});

	return {
		abort: function() {
			log.info("request hls download abort");
			timeStamp = null;
		}
	}
}
