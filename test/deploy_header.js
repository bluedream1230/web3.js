/* globals describe,it */
const assert = require('assert');
const DeployHeader = require('../web3c/deploy_header');

describe('Deploy Header', function() {

  let failTests = [
	{
	  description: 'errors when writing a deploy header to empty bytecode',
	  bytecode: '',
	  header: { expiry: 100000, confidential: false}
	},
	{
	  description: 'errors when writing an invalid deploy header',
	  bytecode: '0x1234',
	  header: { invalid: 1234, expiry: 100000, confidential: false}
	}
  ];

  failTests.forEach((test) => {
	it(test.description, async function() {
	  assert.throws(() => DeployHeader.write(test.header, test.bytecode));
	});
  });

  let successTests = [
	{
	  description: 'does not change the bytecode if the header is empty',
	  bytecode: '0x1234',
	  header: {},
	  expected: '0x1234'
	},
	{
	  description: 'writes a deploy header to non-empty bytecode',
	  bytecode: '0x1234',
	  header: { expiry: 100000, confidential: false},
	  expected: '0x0073697300010026{"expiry":100000,"confidential":false}1234'
	},
	{
	  description: 'overwrites a deploy header to non-empty bytecode with an existing confidential header',
	  bytecode: '0x0073697300010016{"confidential":false}1234',
	  header: { confidential: true},
	  expected: '0x0073697300010015{"confidential":true}1234'
	},
	{
	  description: 'overwrites a deploy header to non-empty bytecode with an existing expiry header',
	  bytecode: '0x0073697300010011{"expiry":100000}1234',
	  header: { expiry: 100001},
	  expected: '0x0073697300010011{"expiry":100001}1234'
	},
	{
	  description: 'overwrites a deploy header to non-empty bytecode with an existing expiry and confidential header',
	  bytecode: '0x0073697300010026{"expiry":100000,"confidential":false}1234',
	  header: { expiry: 100001, confidential: true},
	  expected: '0x0073697300010025{"expiry":100001,"confidential":true}1234'
	}
  ];

  successTests.forEach((test) => {
	it(test.description, function() {
	  let data = DeployHeader.deployCode(test.header, test.bytecode);
	  assert.equal(data, test.expected);
	});
  });
});