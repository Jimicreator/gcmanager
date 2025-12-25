const mongoose = require('mongoose');

let isConnected = false;

module.exports = async function connectToDatabase() {
  if (isConnected) {
    console.log('=> Using existing database connection');
    return;
  }

  console.log('=> Using new database connection');
  
  // This uses the connection string we will set in Netlify later
  await mongoose.connect(process.env.MONGODB_URI);
  
  isConnected = true;
};