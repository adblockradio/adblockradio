var { Transform } = require("stream");
var cp = require("child_process");
var log = require("loglevel");
log.setLevel("debug");

var consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "9-unsure", "todo"]
}

class MlPredictor extends Transform {
	constructor(options) {
		super({ readableObjectMode: true });
		this.canonical = options.country + "_" + options.name;
		var self = this;
	
		// spawn python subprocess
		this.cork();
		this.predictChild = cp.spawn('python', ['-u', 'mlpredict.py', this.canonical, 11025, 1, 16, 2], { stdio: ['pipe', 'pipe', 'pipe'], cwd: __dirname });
		this.predictChild.stdout.on('data', function(msg) {
			//log('Received message from Python worker:\n' + msg.toString());
			if (msg[msg.length-1] == "\n") msg = msg.slice(0,msg.length-1); // remove \n at the end

			if (msg.indexOf("model loaded") >= 0) {
				log.info(self.canonical + " predictor process is ready to crunch audio");
				self.uncork();
			}
			msg = msg.toString();
			var parseTestText = "audio predicted probs=";
			var ijson = msg.indexOf(parseTestText)+parseTestText.length;
			if (ijson >= parseTestText.length) {
				try {
					var results = JSON.parse(msg.slice(ijson, msg.length));
				} catch(e) {
					log.warn(self.canonical + " could not parse json results: " + e + " original data=" + msg.slice(ijson, msg.length));
				}

				log.info(self.canonical + " current type is " + consts.WLARRAY[results.type] + " confidence=" + Math.round(results.confidence*100)/100 + " " +
					//" alt is " + consts.WLARRAY[results.alt] +
					"tMFCC=" + Math.round(results.timings.mfcc*1000) + "ms " +
					"tINF=" + Math.round(results.timings.inference*1000) + "ms " +
					//"buffer=" + Math.round(stream.tBuffer*100)/100 + "s " +
					//"rAvg=" + stream.rAvg + " " +
					"gain=" + Math.round(results.rms*10)/10 + "db " +
					"mem=" + Math.round(process.memoryUsage().rss/1000000) + "+" + Math.round(results.mem/1000000) + "MB"); //+ "softmax=" + results.softmax);

				/*if (isNaN(stream.tBuffer) || stream.tBuffer < 0 || stream.tBuffer > 60) {
					if ((new Date()).getTime() - stream.date.getTime() > 15000) {
						log.warn(stream.padded_radio_name + " has a buffer of " + Math.round(stream.tBuffer*1000)/1000 + "s that looks dubious. restart dl");

						stream.stopDl();
						predictionCallback("buffer", null, stream.getStatus());
						return;
					}*/
					// if stream is young and has tBuffer problems, ignore the predictions
				//} else {
				let outData = {
					type: results.type,
					confidence: results.confidence,
					softmaxs: results.softmax,
					//date: new Date(stream.lastData.getTime() + Math.round(stream.tBuffer*1000)),
					gain: results.rms
				}
				//stream.onNewPrediction(outData);
				self.push({ type:"ml", data:outData });
				//}

				//stream.predictBusy = false;

				//onDecoderChunk(null); // drain the buffer if not empty

			} else {
				log.debug("mlpredict child: " + msg);
			}
		});

		this.predictChild.stderr.on("data", function(msg) {
			log.warn("mlpredict child stderr data: " + msg);
		});
		this.predictChild.stdin.on("error", function(err) {
			log.warn("mlpredict child stdin error: " + err);
		});
		this.predictChild.stdout.on("error", function(err) {
			log.warn("mlpredict child stdout error: " + err);
		});
		this.predictChild.stderr.on("error", function(err) {
			log.warn("mlpredict child stderr error: " + err);
		});

	}

	_write(buf, enc, next) {
		this.predictChild.stdin.write(buf);
		next();
	}
}

module.exports = MlPredictor;
