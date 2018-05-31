"use strict";
const { log } = require("abr-log")("cluster");
const { Analyser } = require("./post-processing.js");

const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

/*var fs = require('fs');
var http = require('http');
var url = require('url');
var cp = require('child_process');
var os = require("os");
var io = require('socket.io');
*/

/*var consts = {
	WLARRAY: ["0-ads", "1-speech", "2-music", "9-unsure", "todo"],
	PRED_INTERVAL: 2.0, // time interval between two audiotype predictions (s)
	PRED_READYAT: 500, // time of audio (ms) remaining in buffer whose prediction we decide is ready to be sent to clients (== latency to reach clients trough frontend)
	TIMEOUT_MARGIN: 100, // margin to compare dates in timeouts

	PCM_SAMPLERATE: 22050,
	PCM_CHANNELS: 1,
	PCM_BITDEPTH: 16,

	SAVE_SEG_DURATION: 10,
	SAVE_EXT: { "MP3": "mp3", "AAC": "aac", "AAC+": "aac", "OGG": "ogg", "HLS": "aac" },

	FLAGS_DIR: "flags/",
	PADDED_RADIO_NAME_LENGTH: 24, 	// padded radio name for logs

	TOKEN_CONFIRM: "confirm by email",
	TOKEN_UNSUBSCRIBE: "unsubscribe email",

	paddedRadioName: function(radioName) {
		var result = radioName.slice(0,this.PADDED_RADIO_NAME_LENGTH);
		for (var i=0,limit=this.PADDED_RADIO_NAME_LENGTH-result.length; i<limit; i++) {
			result += " ";
		}
		return result;
	},

	padNumber: function(num, size) {
		var s = num+"";
		while (s.length < size) s = "0" + s;
		return s;
	},

	findRadioByName: function(radio) {
		var is = -1;
		if (!radio) {
			log.warn("findRadioByName: argument is missing: " + radio);
		} else {
			for (var i=0; i<streams.length; i++) {
				if (streams[i].radio == radio) {
					is = i;
					break;
				}
			}
			if (is < 0) {
				log.warn("findRadioByName: radio " + radio + " not found");
			}
		}
		return is;
	},

	dirDate: function(now) {
		return (now.getUTCFullYear()) + "-" + (now.getUTCMonth()+1 < 10 ? "0" : "") + (now.getUTCMonth()+1) + "-" + (now.getUTCDate() < 10 ? "0" : "") + (now.getUTCDate());
	}
}*/

const findRadioByName = function(radio) {
    if (!radio) {
        log.warn("findRadioByName: argument is missing: " + radio);
        return -1
    } else {
        const is = streams.map(e => e.radio).indexOf(radio)
        if (is < 0) {
            log.warn("findRadioByName: radio " + radio + " not found");
        }
        return is;
    }
}

if (cluster.isMaster) { // master process

    const fs = require("fs");

	var serverName = "";
	try {
		serverName = JSON.parse(fs.readFileSync("config/server_url.json"))["name"];
	} catch(e) {
		log.error("cannot parse server_url.json. err=" + e);
		process.exit(0);
	}
	log.info("server name is " + serverName);

	var streams = [];

	const netjs = require("./net.js");
	const frontendSrv = netjs.server();
	const frontendAllowedUsers = ["frontend"];
	frontendSrv.enableSioAuth(frontendAllowedUsers);
	frontendSrv.server.listen(4242, "localhost");

	frontendSrv.app.use('/.well-known', frontendSrv.express.static('/var/www/html/.well-known')); // lets encrypt
	frontendSrv.sio.on("connection", function(socket) {
		log.info("incoming frontend connection on io from IP " + netjs.getIPSocketIO(socket.handshake) + " and host " + socket.handshake.headers["host"]);

		socket.on("config", function(msg, ackFn) {
			if (!netjs.checkJWT(msg.token, frontendAllowedUsers, netjs.getIPSocketIO(socket.handshake))) return ackFn(null);
			targetRadios(function(err, targetRadioList) {
				if (err) log.warn("could not read list of models : " + err);
				ackFn({ "name": serverName, "radios": targetRadioList });
			});
		});


		// TODO:
		// add sockets to a broadcast room when they are able to authenticate themselves (eg with JWT).
		// broadcast only to this room

		socket.on("status", function(msg) {
			if (!netjs.checkJWT(msg.token, frontendAllowedUsers, netjs.getIPSocketIO(socket.handshake))) {
				log.warn("frontendSrv auth failed for msg status, IP=" + netjs.getIPSocketIO(socket.handshake));
			} else {
				//log.debug("received status: " + JSON.stringify(msg));
				webmin.send({ status: msg });
			}
		});
	});

    /* TODO update webmin
	var webmin = cluster.fork({ "radio": "webmin"});

	webmin.on("message", function(msg) {
		if (msg && msg.command) { // webmin
			//if (msg.webminCommand == "getStreams") {
			var is = consts.findRadioByName(msg.to);
			if (is >= 0) cluster.workers[streams[is].workerId].send(msg);
		}
	});

	webmin.on("error", function(error) {
		log.warn("webmin error: " + error);
	});
    */

	const targetRadios = function(callback) {
		fs.readdir("model", function(err, results) {
			if (err) log.warn("could not read list of models : " + err);

			let targetRadioList = [];
			for (var i=0; i<results.length; i++) {
				if (results[i].slice(-6) != ".keras") continue;
				var spl = results[i].slice(0, results[i].length-6).split("_");
				if (spl.length != 2) log.warn("problem parsing radio name " + results[i]);
				//log.debug("found model for " + spl[0] + "_" + spl[1]);
				targetRadioList.push(spl[0] + "_" + spl[1]);
			}
			callback(err, targetRadioList);
		});
	}

	const loadConfig = function() {
		targetRadios(function(err, targetRadioList) {
			if (err) {
				log.warn("could not read list of models : " + err);
			}

			// remove streams that should be stopped
			//log.debug("check to remove, target list = " + targetRadioList);
			let redoNecessary = true;
			let currentRadioList = [];
			while (streams.length > 0 && redoNecessary) {
				currentRadioList = [];
				for (var i=0; i<streams.length; i++) {
					currentRadioList.push(streams[i].radio);
					if (targetRadioList.indexOf(streams[i].radio) < 0) {
						cluster.workers[streams[i].workerId].send({ "to": streams[i].radio, "command": "shutdown" }); //kill(); //stopDl();
						log.info(streams[i].radio + " removed");
						streams.splice(i,1);
						redoNecessary = true;
						break;
					} else {
						//log.debug(streams[i].radio + " should not be stopped");
					}
					redoNecessary = false;
				}
			}

			// kill streams that have stalled
            let now = new Date();
			for (let i=streams.length-1; i>=0; i--) {
				if (now.getTime() - streams[i].lastPrediction.getTime() > 120000) {
					// the downtime here must be higher than child load time (up to 20s if busy) and buffer length (up to 30s)
					log.warn("stream " + streams[i].radio + " stalled, kill it");
					if (cluster.workers[streams[i].workerId]) cluster.workers[streams[i].workerId].kill();
					streams.splice(i,1);
				}
            }

			// add streams that should be monitored
			for (var i=0; i<targetRadioList.length; i++) {
				if (!currentRadioList.includes(targetRadioList[i])) {
					log.debug(targetRadioList[i] + " should be started");
					const spl = targetRadioList[i].split("_");
					if (spl.length != 2) {
                        log.warn("problem parsing radio name " + targetRadioList[i]);
                        continue;
                    }
                    const country = spl[0];
                    const name = spl[1];
                    var worker = cluster.fork({ country: country, name: name });
                    streams.push({ 
                        "radio": country + "_" + name, 
                        "workerId": worker.id, 
                        "lastPrediction": new Date()
                    });

                    worker.on("message", function(msg) {
                        var is = findRadioByName(country + "_" + name);
                        /*if (msg && msg.error) {
                            if (msg.error == 404) {
                                log.warn("child process had a 404 error on url " + result.url + ", will refresh URL");
                                worker.kill();
                                if (is >= 0) streams.splice(is, 1);
                                //loadConfig();
                            } else if (msg.error == "buffer") {
                                log.warn("child process had a buffer error, restart it");
                                worker.kill();
                                if (is >= 0) streams.splice(is, 1);
                            }
                        } else*/
                        if (msg && msg.prediction && streams[is]) {
                            //log.debug("send prediction from worker " + worker.id + " for radio " + msg.prediction.radio);
                            frontendSrv.sio.emit("predictions", msg.prediction);
                            streams[is].lastPrediction = new Date();
                        } else if (msg && msg.prediction && !streams[is]) {
                            log.warn("received prediction but stream is null");
                        } else {
                            log.warn("unrecognized message: " + msg);
                        }
                        if (msg.status) {
                            var is = findRadioByName(country + "_" + name);
                            if (is >= 0) streams[is]["status"] = msg.status;
                        }
                    });

                    /*
                    (function(country, name) {
						netjs.getRadioMetadata(country, name, function(err, result) {
							if (err) {
								log.warn("problem with query: country=" + country + " name=" + name + " err=" + err);
							} else if (result) {
								log.info("addRadio: url is " + result.url + " with bitrate " + result.bitrate); //result is " + result);
								if (result.url.slice(result.url.length-5, result.url.length) == ".m3u8") { // codec is unknown for HLS streams. overwrite it
									result.codec = "HLS";
								}
								var worker = cluster.fork({ "radio": country + "_" + name, "url": result.url, "bitrate": result.bitrate, "codec": result.codec });
								streams.push({ "radio": country + "_" + name, "workerId": worker.id, "lastPrediction": new Date() });
								worker.on("message", function(msg) {
									var is = consts.findRadioByName(country + "_" + name);
									if (msg && msg.error) {
										if (msg.error == 404) {
											log.warn("child process had a 404 error on url " + result.url + ", will refresh URL");
											worker.kill();
											if (is >= 0) streams.splice(is, 1);
											//loadConfig();
										} else if (msg.error == "buffer") {
											log.warn("child process had a buffer error, restart it");
											worker.kill();
											if (is >= 0) streams.splice(is, 1);
										}
									} else if (msg && msg.prediction && streams[is]) {
										//log.debug("send prediction from worker " + worker.id + " for radio " + msg.prediction.radio);
										frontendSrv.sio.emit("predictions", msg.prediction);
										streams[is].lastPrediction = new Date();
									} else if (msg && msg.prediction && !streams[is]) {
										log.warn("received prediction but stream is null");
									} else {
										log.warn("unrecognized message: " + msg);
									}
									if (msg.status) {
										var is = consts.findRadioByName(country + "_" + name);
										if (is >= 0) streams[is]["status"] = msg.status;
									}
								});
							} else {
								log.warn("problem with query for radio " + country + "_" + name + " result=" + result);
							}
						});
                    })(spl[0], spl[1]);
                    */
				}
			}
            /*
            webmin.send({ "streams": streams });
            */
		});
		setTimeout(loadConfig, 20000); // refresh config and processed streams every 20 seconds.
	}

	loadConfig();

    /*
	var spawnCleaner = function() {
		log.info("spawn cleaner subprocess");
		cluster.fork({ "radio": "cleaner"});
		setTimeout(spawnCleaner, 86400 / 2 * 1000);
	}
    spawnCleaner();
    */

	var logMemory = function() {
		cp.exec("free -m | grep 'buffers/cache'", function(error, stdout, stderr) {
			log.info("memory status: used / free = " + stdout.slice(stdout.indexOf(":")+1, stdout.length-1) + " MB");
		});
		setTimeout(logMemory, 120000);
	}
	logMemory();


} else { // worker

	if (!process.env.radio) {
		log.error("Cluster worker: missing parameters. Exiting.");
    /*
    } else if (process.env.radio == "webmin") {
		var webmin = require("./webmin.js")(consts);
		process.on("message", function(msg) {
			if (msg && msg.streams) {
				webmin.updateStreams(msg.streams);
			} else if (msg && msg.status) {
				webmin.updateStatus(msg.status);
			}
        });
    */
	} else if (process.env.radio == "cleaner") {
		var saveDays = 0;
		try {
			saveDays = parseInt(JSON.parse(fs.readFileSync("config/save_days.json"))["savedays"]);
		} catch(e) {
			log.error("cannot parse server_url.json. err=" + e);
			process.exit(0);
		}
		log.info("server name is " + serverName);
		let date = new Date(+(new Date()) - saveDays * 86400 * 1000);
		log.info("start cleaning old audio files: rm -r \"./records/" + consts.dirDate(date) + "\"");

		cp.exec("ionice -c 3 rm -r \"./records/" + consts.dirDate(date) + "\"", function(error, stdout, stderr) {
			if (error || stderr) {
				log.warn("old audio files from " + consts.dirDate(date) + " cleaned. error=" + error + " stdout=" + stdout + " stderr=" + stderr);
			} else {
				log.info("old audio files from " + consts.dirDate(date) + " cleaned.")
			}
			setTimeout(process.exit, 2000);
		});

	} else {
        const stream = Analyser({
            country: process.env.country,
            name: process.env.name,
            //config:
        });

        stream.on("data", function(obj) {
            process.send({ error: null, prediction: null, status: null });
            // TODO
            //prediction: { "hostname": hostname, "radio": radio, "streamUrl": streamUrl, "type": stream.predictions[i].type, "date": stream.predictions[i].date.toISOString(), "gain": stream.predictions[i].gain }, stream.getStatus());
            //status: { "tBuffer": stream.tBuffer, "rAvg": stream.rAvg, "httpCode": stream.res ? stream.res.statusCode : 0, "uptime": (+new Date()-stream.date) };
        });

		/*var stream = require("./worker.js")(process.env.radio, process.env.url, process.env.bitrate, process.env.codec, consts, function(err, prediction, status) {
			process.send({ "error": err, "prediction": prediction, "status": status });
		});*/
		process.on("message", function(msg) {
			if (msg.to == process.env.radio && msg.command == "refreshModel") {
				stream.newPredictChild();
			} else if (msg.to == process.env.radio && msg.command == "shutdown") {
				stream.stopDl();
				setTimeout(process.exit, 2000);
			}
		});

		//stream.startDl(new Date());
	}
}