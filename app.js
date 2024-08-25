require('dotenv').config({ path: './Config/config.env' });
const express = require('express');
const app = express();
const chatRouter = require('./Routes/chat.js');
const NewErrorHandler = require('./Utils/NewErrorHandler');
const { ErrorController } = require('./Controllers/ErrorController.js');

app.use(express.json());

// Fix: Add a leading slash to 'api'
app.use('/api', chatRouter);

app.all('*', (req, res, next) => next(new NewErrorHandler('Route Not Found', 404)));
app.use(ErrorController);

module.exports = app;
