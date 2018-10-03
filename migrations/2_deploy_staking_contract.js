const QSPb = artifacts.require('QSPb');
const LinkedListLib = artifacts.require('LinkedListLib');

module.exports = function(deployer, network, accounts) {
  deployer.deploy(LinkedListLib)
    .then(() => deployer.link(LinkedListLib, QSPb))
    .then(() => deployer.deploy(QSPb));
};