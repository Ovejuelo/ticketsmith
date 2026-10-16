const express = require('express')
const { Account } = require('../models/account')

const router = express.Router()

router.get('/:id', async (req, res) => {
  const account = await Account.findByPk(req.params.id)
  if (!account) return res.status(404).end()
  res.json(account)
})

router.post('/:id/deactivate', async (req, res) => {
  await Account.update({ status: 'inactive' }, { where: { id: req.params.id } })
  res.status(204).end()
})

module.exports = router
