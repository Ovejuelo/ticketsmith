import React, { useEffect, useState } from 'react'
import { getAccount } from '../api/accounts'

export default function AccountPage({ match }) {
  const [account, setAccount] = useState(null)
  useEffect(() => {
    getAccount(match.params.id).then((response) => setAccount(response.data))
  }, [match.params.id])
  return account ? <h1>{account.email}</h1> : null
}
