const { DataTypes } = require('sequelize')
const sequelize = require('../db')

const Account = sequelize.define('Account', {
  email: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'active' },
})

module.exports = { Account }
