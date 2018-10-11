// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

const { log } = require("abr-log")("demo");
const { Analyser } = require("./post-processing.js");
const cp = require("child_process");
const fs = require("fs");

const country = "France";
const name = "RTL";

log.info("download model...");

cp.execSync("wget https://www.adblockradio.com/models/" + country + "_" + name + ".keras.tar.gz");
cp.execSync("tar -zxvf " + country + "_" + name + ".keras.tar.gz");
cp.execSync("mv " + country + "_" + name + ".keras model/.");
cp.execSync("rm " + country + "_" + name + ".keras.tar.gz");

cp.execSync("wget https://www.adblockradio.com/models/" + country + "_" + name + ".sqlite.tar.gz");
cp.execSync("tar -zxvf " + country + "_" + name + ".sqlite.tar.gz");
cp.execSync("mv " + country + "_" + name + ".sqlite model/.");
cp.execSync("rm " + country + "_" + name + ".sqlite.tar.gz");

log.info("start analyser!");

const abr = new Analyser({
	country: country,
	name: name,
	config: {
		predInterval: 1,
		saveDuration: 10,
		enablePredictorHotlist: true,
		enablePredictorMl: true,
		saveAudio: true,
		saveMetadata: true,
		fetchMetadata: true,
		verbose: true,
	}
});

abr.on("data", function(obj) {
	obj.liveResult.audio = "[redacted]";
	log.info("status=" + JSON.stringify(Object.assign(obj, { audio: undefined }), null, "\t"));
});
