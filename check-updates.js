'use strict';

const axios = require('axios');
const tar = require('tar');
const fs = require('fs-extra');
const { log } = require('abr-log')('checkModelUpdates');
const assert = require('assert');

const MODELS_REPOSITORY = 'https://www.adblockradio.com/models/';
const METADATA_REPOSITORY = 'https://www.adblockradio.com/metadata/';
const CHECKSUM_SUFFIX = '.sha256sum';

const isToUpdate = async function(localFile, remoteFile) {
	let localChecksum = null;
	try {
		localChecksum = await fs.readFile(localFile + CHECKSUM_SUFFIX);
	} catch (e) {
		log.info('checksum for ' + localFile + ' not found. Will fetch models.');
		return true;
	}
	try {
		const remoteChecksum = await axios.get(encodeURI(remoteFile + CHECKSUM_SUFFIX));
		if ('' + localChecksum !== '' + remoteChecksum.data) {
			//log.info('different checksums local=' + localChecksum + ' remote=' + remoteChecksum.data);
			return true;
		} else {
			log.info(localFile + ' is up to date');
			return false;
		}
	} catch (e) {
		log.warn('could not fetch ' + remoteFile + CHECKSUM_SUFFIX + '. err=' + e);
		return false;
	}
}

const update = async function(remoteFile, localFile, options) { //localPath, remotePath, file) {
	log.info('update ' + localFile);
	try {
		const localFileSplit = localFile.split('/');
		const localPath = localFileSplit.slice(0, localFileSplit.length - 1).join('/');
		//log.debug("localPath=" + localPath);
		try {
			await fs.mkdir(localPath, { recursive: true });
		} catch (e) {
			if (!('' + e).includes('EEXIST')) {
				log.error("Cannot create model directory " + localPath);
				throw e;
			}
		}
		const checksumData = await axios.get(encodeURI(remoteFile + CHECKSUM_SUFFIX));
		await fs.writeFile(localFile + CHECKSUM_SUFFIX, checksumData.data);
		const data = await axios.get(encodeURI(remoteFile), { responseType: 'arraybuffer' });
		await fs.writeFile(localFile, data.data);
		if (options && options.untar) {
			await tar.x({ file: localFile, cwd: localPath, strict: true });
			await fs.unlink(localFile);
		}
	} catch (e) {
		log.warn('could not update with remote ' + remoteFile + '. err=' + e);
	}
}

exports.checkModelUpdates = async function(params) {
	assert(params.localPath);
	assert(params.files);

	//const canonical = params.country + '_' + params.name;

	for (let i=0; i<params.files.length; i++) {
		const modelFile = params.files[i].file;
		const tared = !!params.files[i].tar;
		const localFile = params.localPath + '/' + modelFile + (tared ? '.tar.gz' : '');
		const remoteFile = MODELS_REPOSITORY + modelFile + (tared ? '.tar.gz' : '');
		if (await isToUpdate(localFile, remoteFile)) {
			await update(remoteFile, localFile, { untar: tared });
			if (params.files[i].callback) params.files[i].callback();
		}
	}
}

exports.checkMetadataUpdates = async function(updateCallback) {
	log.debug("check meta updates");
	const file = 'webradio-metadata.js.tar.gz';
	const localFile = process.cwd() + '/' + file;
	const remoteFile = METADATA_REPOSITORY + '/' + file;
	if (await isToUpdate(localFile, remoteFile)) {
		await update(remoteFile, localFile, { untar: true });
		if (updateCallback) updateCallback();
	}
}