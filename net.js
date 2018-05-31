"use strict";
const { log } = require("abr-log")("net", true);
const http = require('http');
const fs = require("fs");
const https = require('https');
const jwt = require('jsonwebtoken'); // used to create, sign, and verify tokens
const { URL } = require('url');
const publicIp = require('public-ip');

publicIp.v4().then(newIp => {
	pubIp = newIp;
	log.debug("public IP is " + pubIp);
});

exports.server = function() {
	const express = require('express');
	const helmet = require('helmet');
	const bodyParser = require("body-parser");
	const appAdmins = express();
	appAdmins.use(helmet());
	appAdmins.use(bodyParser.urlencoded({ extended: false }));
	appAdmins.use(bodyParser.json());
	const serverAdmins = http.createServer(appAdmins);
	const admins = require('socket.io')(serverAdmins);
	
	return { "app": appAdmins, "sio": admins, "server": serverAdmins, "express": express,
		enableSioAuth: function(allowedUsers) { // auth for socket.io sockets
			admins.on("connection", function(socket) {
				socket.on("authentication", function(msg, ackFn) {
					log.info("sio auth " + exports.getDeviceInfoSocketIO(socket.handshake));
					login(decodeURIComponent(msg.username), decodeURIComponent(msg.password), allowedUsers, exports.getIPSocketIO(socket.handshake), function(res) {
						if (ackFn) {
							ackFn(res);
						} else {
							log.warn("token could not be sent, no ackFn provided");
						}
					});
				});

			});
		},
		enableExpressAuth: function(allowedUsers) { // auth for express requests
			appAdmins.use('/login.html', express.static('res/login.html'));
			appAdmins.post('/login', function(request, response) {
				log.info("/login " + exports.getDeviceInfoExpress(request));
				login(decodeURIComponent(request.body.user), decodeURIComponent(request.body.password), allowedUsers, exports.getIPExpress(request), function(msg) {
					response.json(msg);
				});
			});
		} //"authmw": authmw
	}
}


const login = function(user, pass, allowedUsers, ip, callback) {
	checkCredentials(user, pass, function(isValid) {
		if (isValid && allowedUsers.indexOf(user) < 0) {
			log.warn("login failed for user " + user + ", username not allowed");
			callback({ "error": "login failed" });

		} else if (isValid) {
			log.info("successful login, will generate token...");
			let token = newToken(user, ip);
			callback({ "error": null, "token": token });

		} else {
			log.warn("login failed for user " + user);
			callback({ "error": "login failed" });

		}
	});
}

const checkCredentials = function(user, pass, callback) {
    const bcrypt = require("bcrypt");
    let users;
	fs.readFile("./config/secrets.json", function(err, data) {
		try {
			let jdata = JSON.parse(data);
			users = jdata.credentials;
		} catch (e) {
			log.error("could not load credentials. e=" + e);
			callback(false);
		}

        const userIndex = users.map(e => e.user).indexOf(user);

		bcrypt.compare(pass, users[userIndex].hash, function(err, res) {
			if (err) {
				log.warn("could not compare bcrypt hashes. err=" + err);
				callback(false);
			} else if (userIndex < 0) {
				callback(false);
			} else {
				callback(res);
			}
		});
	});
}

let JWTSecret = "";
fs.readFile("./config/secrets.json", function(err, data) {
	try {
		JWTSecret = JSON.parse(data).jwtsecret;
	} catch (e) {
		log.error("could not load credentials: e=" + e);
		process.exit(0);
	}
});

const newToken = function(user, ip) {
	log.debug("generate new token for user=" + user + " ip=" + ip);
	if (ip == "127.0.0.1") { // || ip == "localhost") {
		log.debug("newToken: substitute local ip=" + ip + " with public ip=" + pubIp);
		return newToken(user, pubIp);
	} else {
		return jwt.sign({ user: user, ip: ip }, JWTSecret, { expiresIn: "24h" });
	}
}

exports.checkJWT = function(token, allowedUsers, ip) {
	let decoded;
	try {
		decoded = jwt.verify(token, JWTSecret);
	} catch (err) {
		log.warn("token could not be verified: decoded=" + decoded + " err=" + err);
		return false;
	}
	if (!decoded || !decoded.user || !decoded.ip) {
		log.warn("token payload does not have the correct structure: " + JSON.stringify(decoded));
		return false;
	}

	if (decoded.ip == "127.0.0.1") {
		//log.debug("checkJWT: substitute jwt local ip=" + ip + " with public ip=" + pubIp);
		decoded.ip = pubIp;
	}
	if (ip == "127.0.0.1") {
		//log.debug("checkJWT: substitute requester local ip=" + ip + " with public ip=" + pubIp);
		ip = pubIp;
	}

	let i = allowedUsers.indexOf(decoded.user);
	if (i >= 0 && decoded.ip == ip) {
		//log.debug("token verified for " + allowedUsers[i] + " IP " + ip);
		return true;
	} else {
		log.warn("token has mismatching payload: user " + decoded.user + " vs " + allowedUsers + " & IP=" + decoded.ip + " vs " + ip);
		return false;
	}
}

exports.authMw = function(expressAllowedUsers) {

	return function(request, response, next) {
		//console.log("request with token=" + request.query.t);
		let auth = exports.checkJWT(request.query.t, expressAllowedUsers, exports.getIPExpress(request));
		if (!auth) {
			log.warn("webmin auth failed for " + request.originalUrl + " IP=" + exports.getIPExpress(request));
			if (request.originalUrl.indexOf("/index.html") == 0 || request.originalUrl == "/") {
				response.redirect("/login.html");
			} else {
				response.sendStatus(403).end("");
			}

		} else {
			log.debug("webmin auth successful");
			next();
		}
	}
}


exports.getIPSocketIO = function(handshake) {
	if (!handshake || !handshake.headers) return "unknown handshake parameters";
	var ip = null;
	if (handshake && handshake.headers) ip = handshake.headers['x-forwarded-for']; // standard proxy header
	if (!ip && handshake && handshake.headers) ip = handshake.headers['x-real-ip']; // nginx proxy header
	if (!ip && handshake && handshake.address) ip = handshake.address;
	return ip;
}

exports.getIPExpress = function(request) {
	var ip = request.headers['x-forwarded-for']; // standard proxy header
	if (!ip) ip = request.headers['x-real-ip']; // nginx proxy header
	if (!ip) ip = request.connection.remoteAddress;
	return ip;
}

exports.getDeviceInfoExpress = function(request) {
    const agent = request.headers['user-agent'];
    return "login from IP " + exports.getIPExpress(request) + " and UA " + agent;
}

exports.getDeviceInfoSocketIO = function(handshake) {
	if (!handshake || !handshake.headers) return "login ip=" + exports.getIPSocketIO(handshake) + " but unknown handshake parameters";
	const agent = handshake.headers['user-agent'];
	const languages = handshake.headers["accept-language"];
	return "login ip=" + exports.getIPSocketIO(handshake) + " UA=" + agent + " lang=" + languages;
}

/*
const { Writable } = require("stream");

const express = require('express');
const helmet = require('helmet');
//var bodyParser = require("body-parser");
const app = express();
app.use(helmet());
//app.use(bodyParser.urlencoded({ extended: false }));
//app.use(bodyParser.json());
const server = http.createServer(appAdmins);
const sio = require('socket.io')(server);
server.listen(4242, "localhost");

const BUFFER_LEN = 8; // number of written segments to include once a new client has connected.
const buffer = [];

sio.on("connection", function(socket) {
    // TODO
    // send all buffer
});

// net.js builds a writable stream, where data is gathered as a buffer,
// then broadcast to clients connecting to it.

class Net extends Writable { // FIXME is it necessary to use Writable here? it could be simplified.
    constructor() {
		super({ objectMode: true });
    }
    
    _write(data, enc, next) {
        // broadcast to all connected clients
        sio.emit(data);

        // add data to buffer
        buffer.push(data);
        if (buffer.length > BUFFER_LEN) buffer.splice(0, buffer.length - BUFFER_LER);

        next();
    }
}
*/