var Dl = require("./dl.js");

var dl = new Dl({ country: "France", name: "Radio Nova", segDuration: 3 });
dl.on("metadata", function(data) {
	console.log("metadata url=" + data.url + " codec=" + data.codec + " ext=" + data.ext + " bitrate=" + data.bitrate);
});
dl.on("newsegment", function(tBuffer, onReadyCallback) {
	console.log("new segment here. tBuffer=" + Math.round(tBuffer*10)/10 + " seconds.");
	onReadyCallback();
});
dl.on("data", function(data) {
	console.log(data.length);
});
dl.on("error", function(err) {
	console.log("err=" + err);
});
