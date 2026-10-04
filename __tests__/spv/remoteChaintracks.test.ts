import { makeRemoteChaintracks } from '@bsv/expo-wallet-toolbox/core/spv/remoteChaintracks'
import { RawChaintracksClient } from '@bsv/expo-wallet-toolbox/core/spv/rawChaintracksClient'
import { ChaintracksServiceClient } from '@bsv/wallet-toolbox-mobile'

describe('makeRemoteChaintracks', () => {
  const url = 'http://192.168.1.20:8083/chaintracks/v1'
  it('uses the toolbox client by default', () => {
    expect(makeRemoteChaintracks('test', url, {})).toBeInstanceOf(ChaintracksServiceClient)
  })
  it('uses the raw client when the chain has non-mainnet (regtest) rules, which the toolbox client would refuse', () => {
    expect(makeRemoteChaintracks('test', url, { rules: 'regtest' })).toBeInstanceOf(RawChaintracksClient)
  })
})
