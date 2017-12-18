const { Readable } = require('stream');
var log = require("loglevel");
log.setLevel(0);
var url = require("url");
var m3u8handler = require("./m3u8handler.js");
var get = require("./get.js");
var http = require("http");
var https = require("https");

var consts = {
	SAVE_EXT: { "MP3": "mp3", "AAC": "aac", "AAC+": "aac", "OGG": "ogg", "HLS": "aac" },
	API_PATH: "http://www.radio-browser.info/webservice/json/stations/bynameexact/"
}

class StreamDl extends Readable {

	constructor(options) {
		if (!options) options = {};
		options.objectMode = true;
		super(options);
		this.country = options.country;
		this.name = options.name;
		this.canonical = this.country + "_" + this.name;
		this.receivedBytes = 0;
		this.receivedBytesInCurrentSegment = 0;
		this.tBuffer = 0;
		this.segDuration = options.segDuration;

		var self = this;
		this.getRadioMetadata(this.country, this.name, function(err, result) {
			if (err || !result) {
				log.warn(self.canonical + " problem fetching radio info: " + err);
				return self.emit("error", "problem fetching radio info: " + err);
			}
			self.url = result.url;
			self.origUrl = result.url;
			self.codec = result.codec;
			self.bitrate = result.bitrate;
			self.emit("metadata", {	url: self.url, codec: self.codec, ext: consts.SAVE_EXT[self.codec], bitrate: self.bitrate });
			self.startDl();
		});
	}

	getRadioMetadata(country, name, callback) {
		get(consts.API_PATH + encodeURIComponent(name), function(err, result) { //, corsEnabled
			if (err || !result) {
				return callback(err, null);
			}

			try {
				var results = JSON.parse(result);
			} catch(e) {
				return callback(e.message, null);
			}

			for (var i=0; i<results.length; i++) {
				if (results[i].country == country) {
					log.info("getRadioMetadata: radio found: " + JSON.stringify(results[i]));

					if (!isNaN(results[i].bitrate) && results[i].bitrate > 0) {
						results[i].bitrate = results[i].bitrate * 1000 / 8; // result in kbps
					} else {
						results[i].bitrate = 128000 / 8; // * SEG_DURATION;
						log.warn("getRadioMetadata: default bitrate to 128k");
					}

					return callback(null, results[i]);
				}
			}
			log.error("getRadioMetadata: radio not found: " + results);
			return callback(null, null);
		});
	}

	checkAlive(requestDate) {
		if (requestDate != this.date || this.toBeDestroyed) return;

		if (new Date() - this.lastData > 10000) {
			log.info(this.canonical + " stream seems idle, we restart it");
			this.startDl(null);
		} else {
			var self = this;
			setTimeout(function() { self.checkAlive(requestDate); }, 4000);
		}
	}

	startDl(timestamp) {
		var self = this;

		log.debug(this.canonical + " start dl url= " + this.url + " codec " + this.codec + " (*." + consts.SAVE_EXT[this.codec] + "), bitrate expected to be " + this.bitrate);
		if (!consts.SAVE_EXT[this.codec]) {
			log.error("codec " + this.codec + " is not supported");
			return this.emit("error", "codec " + codec + " is not supported");
		}
		if (this.date && timestamp && timestamp != this.date) {
			log.debug("startDl has been called with the wrong timestamp, abort. current=" + timestamp + " official=" + this.date);
			return;
		}
		this.date = new Date();
		this.firstData = null;
		this.lastData = new Date();
		this.res = null;

		if (this.req) this.req.abort();

		setTimeout(function() { self.checkAlive(self.date); }, 5000);

		var urlParsed = url.parse(this.url);
		if (this.codec == "HLS") {
			this.req = m3u8handler(urlParsed, function(data, delay) {
				// hls blocks may provide data in too big blocks. inject it progressively in the analysis flow
				self.onData(data);
			});


		} else {
			var urlloc = url.parse(this.url);
			//log.debug(JSON.stringify(urlloc));
			this.req = (urlParsed.protocol == "http:" ? http : https).get(urlParsed, function (res) {
				self.res = res;
				log.debug(self.canonical + " got response code " + res.statusCode + " and headers " + JSON.stringify(res.headers));

				res.resume();

				// management of common connection problems that sometimes occur
				if (res.statusCode == 404) {
					self.stopDl();
					//predictionCallback(404, null, stream.getStatus());
					return this.emit("error", "404");
				} else if (res.headers["www-authenticate"] || res.statusCode == 500 || res.statusCode == 502) {
					// request fail... restart required. e.g. fr_ouifm {"www-authenticate":"Basic realm=\"Icecast 2.3.3-kh9\""}
					// 404 {"server":"nginx/1.2.1","date":"Wed, 07 Sep 2016 08:48:53 GMT","content-type":"text/html","connection":"close"}
					(function(timestamp) { setTimeout(function() { self.startDl(timestamp); }, 10000); })(self.date);
					self.req.abort();
					//predictionCallback(res.statusCode, null, stream.getStatus());
					return; // self.emit("warn", res.statusCode);
				} else if ((res.statusCode == 301 || res.statusCode == 302) && res.headers["location"]) { //  && res.headers["connection"] == "close"
					// redirect e.g. fr_nrj {"server":"Apache-Coyote/1.1","set-cookie":["JSESSIONID=F41DB621F21B84920E2F7F0E92209B67; Path=/; HttpOnly"],
					// "location":"http://185.52.127.132/fr/30001/mp3_128.mp3","content-length":"0","date":"Wed, 13 Jul 2016 08:08:09 GMT","connection":"close"}
					self.url = res.headers.location;
					log.info(self.canonical + "following redirection to " + self.url);
					self.req.abort();
					self.startDl(null);
					return;
				} else if (["audio/x-mpegurl", "audio/x-scpls; charset=UTF-8", "audio/x-scpls", "video/x-ms-asf"].indexOf(res.headers["content-type"]) >= 0) { // M3U, PLS or ASF playlist
					log.debug(self.canonical + " url is that of a playlist. read it");
					var playlistContents = "";
					var isM3U = res.headers["content-type"] == "audio/x-mpegurl";
					var isASF = res.headers["content-type"] == "video/x-ms-asf";
					self.res.on('data', function(data) {
						playlistContents += data;
					});
					self.res.on('end', function() {
						//log.debug(stream.padded_radio_name + " received the following playlist:\n" + playlistContents);
						var lines = playlistContents.split("\n");
						var newUrlFound = false;
						for (var i=lines.length-1; i>=0; i--) {
							if (isM3U && lines[i].slice(0, 7) == "http://") {
								self.url = lines[i];
								newUrlFound = true;
								break;
							} else if (isASF) {
								var p1 = lines[i].indexOf("<REF HREF=\"");
								if (p1 < 0) continue
								if (lines[i].slice(p1+11, p1+18) == "http://") {
									self.url = lines[i].slice(p1+11).split("\"")[0];
									newUrlFound = true;
									break;
								}
							} else if (!isM3U && !isASF) {
								var p1 = lines[i].indexOf("=");
								if (p1 < 0) continue
								if (lines[i].slice(p1+1, p1+8) == "http://") {
								self.url = lines[i].slice(p1+1);
								newUrlFound = true;
								break;
								}
							}
						}
						if (newUrlFound) {
							self.startDl(null)
						} else {
							log.error(self.canonical + " could not parse playlist");
							return self.emit("error", "could not parse playlist"); //predictionCallback(42, null, stream.getStatus());
						}
					});

				} else if (res.statusCode != 200) {
					(function(timestamp) { setTimeout(function() { self.startDl(timestamp); }, 2000); })(self.date);
				} else {
					self.res.on('data', function(data) {
						self.onData(data);
					});

					self.res.on('close', function() {
						log.warn(self.canonical + "server response has been closed" + (self.toBeDestroyed ? " (on demand)" : ""));
						self.req.abort();
						if (!self.toBeDestroyed) {
							(function(timestamp) { setTimeout(function() { self.startDl(timestamp); }, 5000); })(self.date);
						}
					});
				}
			});

			this.req.on('error', function(e) {
				if (e.message == "Parse Error") {
					log.info(self.canonical + ' seems to follow HTTP/0.9 spec. retry with curl');
					self.altreq = cp.spawn("curl", ["-L", self.url], { stdio: ['pipe', 'pipe', 'pipe'] });
					self.altreq.stdout.on("data", function(data) {
						self.onData(data);
					});
				} else {
					log.error(self.canonical + ' problem with request: ' + e.message);
					(function(timestamp) {
						setTimeout(function() {
							self.getRadioMetadata(self.country, self.name, function(err, result) {
								if (err) {
									log.warn(self.canonical + " problem fetching radio info: " + err);
								}
								if (result != null && self.url != result.url) {
									log.warn(self.canonical + " URL updated from " + self.url + " to " + result.url);
									log.warn(self.canonical + " original url was " + self.origUrl);
									self.url = result.url;
									self.origUrl = result.url;
									self.bitrate = result.bitrate;
								}
								self.startDl(timestamp);
							});
						}, 5000);
					})(self.date);
				}
			});
		}
	}

	onData(data) {
		var self = this;
		var newSegment = false;
		if (this.firstData == null) {
			this.firstData = new Date();
			log.info(this.canonical + " first data received at " + this.firstData);
			//this.pause();
			//this.emit("newsegment", this.tBuffer, function() {
				//self.resume();
				//return self.onData(data);
				//log.debug("onData: ready for first segment, resume the dl stream");
			//});
			//return;
			newSegment = true;
		}
		this.lastData = new Date();
		this.receivedBytes += data.length;
		this.receivedBytesInCurrentSegment += data.length;
		this.tBuffer = this.receivedBytes / this.bitrate - (this.lastData - this.firstData)/1000;

		var limitBytes = this.segDuration * this.bitrate;

		if (limitBytes > 0 && this.receivedBytesInCurrentSegment > limitBytes) {
			this.push({ newSegment: newSegment, tBuffer: this.tBuffer, data: data.slice(0, limitBytes - this.receivedBytesInCurrentSegment) });
			//this.pause();
			//log.debug("onData: limitBytes=" + limitBytes + " hit, pause the dl stream");
			this.push({ newSegment: true, tBuffer: this.tBuffer, data: data.slice(limitBytes - this.receivedBytesInCurrentSegment) });
			//this.emit("newsegment", this.tBuffer, function() {
			self.receivedBytesInCurrentSegment -= limitBytes;
				//self.resume();
				//log.debug("onData: ready for next segment, resume the dl stream");
			//});
		} else {
			this.push({ newSegment: newSegment, tBuffer: this.tBuffer, data: data });
		}
	}

	stopDl() {
		this.toBeDestroyed = true; // disables safety nets that restart the dl
		if (this.req && this.req.abort) {
			this.req.abort();
			log.debug(this.canonical + " http request aborted on demand");
		}
		if (this.predictChild && this.predictChild.kill) {
			this.predictChild.kill();
			log.debug(this.canonical + " predictor child process killed");
		}
		if (this.decoder && this.decoder.stop) {
			this.decoder.stop();
			log.debug(this.canonical + " ffmpeg converter stopped");
		}
	}

	_read() {

	}
}

module.exports = StreamDl;
