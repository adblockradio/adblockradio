"use strict";
var { Writable, Transform } = require("stream");
var fs = require("fs");
var { log } = require("abr-log")("pred-db");
var cp = require("child_process");

var dirDate = function(now) {
	return (now.getUTCFullYear()) + "-" + (now.getUTCMonth()+1 < 10 ? "0" : "") + (now.getUTCMonth()+1) + "-" + (now.getUTCDate() < 10 ? "0" : "") + (now.getUTCDate());
}

class Db {
	constructor(options) {
		this.country = options.country;
		this.name = options.name;
		this.path = options.path;
		this.ext = options.ext;
		this.saveAudio = options.saveAudio;
	}

	newAudioSegment(callback) {
		var now = new Date();
		var dir = this.path + "/records/" + dirDate(now) + "/" + this.country + "_" + this.name + "/todo/";
		var path = dir + now.toISOString();
		log.debug("saveAudioSegment: path=" + path);
		var self = this;
		cp.exec("mkdir -p \"" + dir + "\"", function(error, stdout, stderr) {
			if (error) {
				log.error("warning, could not create path " + path);
			}

			callback({
				audio: self.saveAudio ? new fs.createWriteStream(path + "." + self.ext) : null,
				metadataPath: path + ".json"
			});
		});
	}
}

module.exports = Db;
