FROM nginx:latest
ARG VERSION=dev
COPY dist-configurator /usr/share/nginx/html
COPY nginx-offline.conf.template /etc/nginx/conf.d/default.conf
RUN sed -i "s/__VERSION__/${VERSION}/g" /etc/nginx/conf.d/default.conf
