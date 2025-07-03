import dotenv from 'dotenv';
import app from './app.js';
//import "./src/middleware/cronjobs.js"

dotenv.config();

const PORT = process.env.PORT || 5020;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});