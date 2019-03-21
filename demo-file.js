// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

const { log } = require("abr-log")("demo-file");
const { Analyser } = require("./post-processing.js");

log.info("start analyser!");

const FILE = process.argv[2] || "podcasts/example.mp3";
log.info("FILE=" + FILE);

const t1 = new Date();

const abr = new Analyser({
	country: "France",
	name: "RTL",
	config: {
		file: FILE,
		predInterval: 1,
		enablePredictorHotlist: true,
		enablePredictorMl: true,
		saveMetadata: true,
		verbose: false,
	}
});

abr.on("data", function(obj) {
	log.info(JSON.stringify(obj, null, "\t"));
});

abr.on("close", function() {
	const t2 = new Date();
	log.info("finished analysing file " + FILE + " in " + (+t2-t1)/1000 + " seconds");
});
