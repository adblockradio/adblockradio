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
			//log.debug("saveAudioSegment: callback");

			callback({
				audio: self.saveAudio ? new fs.createWriteStream(path + "." + self.ext) : null,
				metadata: new MetaWriteStream(path + ".json"),
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

		// some fields are saved in an array
		if (meta.array) {
			if (!this.meta[meta.type]) this.meta[meta.type] = [];
			this.meta[meta.type].push(meta.data);
		} else {
			this.meta[meta.type] = meta.data;
		}
		next();
	}

	_final(next) {
		//log.debug("MetaWriteStream: end. meta=" + JSON.stringify(this.meta));
		this.file.end(JSON.stringify(this.meta, null, '\t'));
		this.ended = true;
		next();
	}
}

module.exports = Db;
