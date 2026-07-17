FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN chmod +x setup-frontend.sh && sh setup-frontend.sh
RUN mkdir -p logs uploads

EXPOSE 5000

CMD ["node", "server.js"]
