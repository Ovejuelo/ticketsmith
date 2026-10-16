const express = require('express')
const accounts = require('./routes/accounts')

const app = express()
app.use(express.json())
app.use('/api/accounts', accounts)
app.get('/health', (req, res) => res.send('ok'))

app.listen(process.env.PORT || 3000)
