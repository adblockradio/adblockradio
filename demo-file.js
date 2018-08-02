const { log } = require("abr-log")("demo-file");
const { Analyser } = require("./post-processing.js");

log.info("start analyser!");

const FILE = "files/merge.mp3";

const abr = new Analyser({
	country: "France",
	name: "RTL",
	config: {
		file: FILE,
		predInterval: 1,
		enablePredictorHotlist: true,
		enablePredictorMl: true,
		saveMetadata: true,
		verbose: true,
	}
});

abr.on("data", function(obj) {
	log.info("status=" + JSON.stringify(obj, null, "\t"));
});

abr.on("end", function() {
	log.info("finished analysing file " + FILE);
});
