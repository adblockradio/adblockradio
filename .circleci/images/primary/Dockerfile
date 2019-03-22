FROM node:dubnium-jessie

RUN echo "deb http://http.debian.net/debian jessie-backports main" >> /etc/apt/sources.list.d/ffmpeg.list \
	&& apt-get update \
	&& apt-get dist-upgrade -y \
	&& apt-get install -y git ssh tar gzip ca-certificates build-essential python-dev sqlite3 \
	&& apt-get install -y ffmpeg -t jessie-backports

RUN cd /tmp && wget https://bootstrap.pypa.io/get-pip.py && python get-pip.py

RUN /usr/local/bin/pip install python_speech_features h5py numpy scipy keras tensorflow zerorpc sounddevice psutil