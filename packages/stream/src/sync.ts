import axios from 'axios'

const API_URL = process.env.API_URL || 'http://localhost:10010/graphql'
export const sync = async (): Promise<void> => {
  await axios({
    url: API_URL,
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      // ...other headers
    },
    data: {
      query: `
          mutation RefreshNFTOrder($refreshNftOrderId: ID!, $force: Boolean) {
            refreshNFTOrder(id: $refreshNftOrderId, force: $force)
          }
          `,
      variables: {
        refreshNftOrderId: 2,
        city: 'Test',
      },
    },
  })
}

