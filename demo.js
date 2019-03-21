// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

const { log } = require("abr-log")("demo");
const { Analyser } = require("./post-processing.js");

const country = "Finland";
const name = "Basso Radio";

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
	//log.info("status=" + JSON.stringify(Object.assign(obj, { audio: undefined }), null, "\t"));
});

abr.on("end", function() {
	log.info("analyser ended");
});

//setTimeout(abr.stopDl, 15000);