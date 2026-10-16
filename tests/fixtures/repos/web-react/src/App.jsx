import React from 'react'
import { BrowserRouter, Route, Switch } from 'react-router-dom'
import AccountPage from './pages/AccountPage'

export default function App() {
  return (
    <BrowserRouter>
      <Switch>
        <Route path="/accounts/:id" component={AccountPage} />
      </Switch>
    </BrowserRouter>
  )
}
