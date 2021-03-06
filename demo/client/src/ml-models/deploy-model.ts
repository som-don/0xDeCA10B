import Web3 from 'web3'
import { Contract } from 'web3-eth-contract'
import DensePerceptron from '../contracts/compiled/DensePerceptron.json'
import NaiveBayesClassifier from '../contracts/compiled/NaiveBayesClassifier.json'
import NearestCentroidClassifier from '../contracts/compiled/NearestCentroidClassifier.json'
import SparseNearestCentroidClassifier from '../contracts/compiled/SparseNearestCentroidClassifier.json'
import SparsePerceptron from '../contracts/compiled/SparsePerceptron.json'
import { convertDataToHex, convertToHex } from '../float-utils'
import { Model, NaiveBayesModel, NearestCentroidModel, PerceptronModel} from './model-interfaces'

export class ModelDeployer {
	/**
	 * The default value for toFloat.
	 */
	private static readonly toFloat = 1E9

	/**
	 * Block gas limit by most miners as of October 2019.
	 */
	public readonly gasLimit = 8.9E6

	static readonly modelTypes: any = {
		'naive bayes': NaiveBayesClassifier,
		'nearest centroid classifier': NearestCentroidClassifier,
		'dense nearest centroid classifier': NearestCentroidClassifier,
		'sparse nearest centroid classifier': SparseNearestCentroidClassifier,
		'perceptron': DensePerceptron,
		'dense perceptron': DensePerceptron,
		'sparse perceptron': SparsePerceptron,
	}

	constructor(private web3: Web3) {
	}

	async deployNaiveBayes(model: NaiveBayesModel, options: any): Promise<Contract> {
		const { account, toFloat,
			notify, dismissNotification,
			saveTransactionHash, saveAddress,
		} = options

		const defaultSmoothingFactor = 1
		const initialFeatureChunkSize = 150
		const featureChunkSize = 350
		const { classifications, classCounts, featureCounts, totalNumFeatures } = model
		const smoothingFactor = convertToHex(model.smoothingFactor || defaultSmoothingFactor, this.web3, toFloat)

		const ContractInfo = ModelDeployer.modelTypes[model.type]
		const contract = new this.web3.eth.Contract(ContractInfo.abi, undefined, { from: account })
		const pleaseAcceptKey = notify(`Please accept the prompt to deploy the Naive Bayes classifier`)

		return contract.deploy({
			data: ContractInfo.bytecode,
			arguments: [[classifications[0]], [classCounts[0]], [featureCounts[0].slice(0, initialFeatureChunkSize)], totalNumFeatures, smoothingFactor]
		}).send({
			from: account,
			gas: this.gasLimit,
		}).on('transactionHash', transactionHash => {
			dismissNotification(pleaseAcceptKey)
			notify(`Submitted the model with transaction hash: ${transactionHash}. Please wait for a deployment confirmation.`)
			saveTransactionHash('model', transactionHash)
		}).on('error', err => {
			dismissNotification(pleaseAcceptKey)
			notify("Error deploying the model", { variant: 'error' })
			throw err
		}).then(async newContractInstance => {
			const addClassPromises = []
			for (let i = 1; i < classifications.length; ++i) {
				addClassPromises.push(new Promise((resolve, reject) => {
					const notification = notify(`Please accept the prompt to create the "${classifications[i]}" class`)
					newContractInstance.methods.addClass(
						classCounts[i], featureCounts[i].slice(0, initialFeatureChunkSize), classifications[i]
					).send({
						from: account,
						// Block gas limit by most miners as of October 2019.
						gas: this.gasLimit,
					}).on('transactionHash', () => {
						dismissNotification(notification)
					}).on('error', (err: any) => {
						dismissNotification(notification)
						notify(`Error creating the "${classifications[i]}" class`, { variant: 'error' })
						reject(err)
					}).then(resolve)

				}))
			}
			return Promise.all(addClassPromises).then(async _ => {
				// Add remaining feature counts.
				for (let classification = 0; classification < classifications.length; ++classification) {
					for (let j = initialFeatureChunkSize; j < featureCounts[classification].length; j += featureChunkSize) {
						const notification = notify(`Please accept the prompt to upload the features [${j},${Math.min(j + featureChunkSize, featureCounts[classification].length)}) for the "${classifications[classification]}" class`)
						await newContractInstance.methods.initializeCounts(
							featureCounts[classification].slice(j, j + featureChunkSize), classification).send().on('transactionHash', () => {
								dismissNotification(notification)
							}).on('error', (err: any) => {
								dismissNotification(notification)
								notify(`Error setting feature indices for [${j},${Math.min(j + featureChunkSize, featureCounts[classification].length)}) for the "${classifications[classification]}" class`, { variant: 'error' })
								throw err
							})
					}
				}
				notify(`The model contract has been deployed to ${newContractInstance.options.address}`, { variant: 'success' })
				saveAddress('model', newContractInstance.options.address)
				return newContractInstance
			})
		})
	}

	async deployNearestCentroidClassifier(model: NearestCentroidModel, options: any): Promise<Contract> {
		const { account, toFloat,
			notify, dismissNotification,
			saveTransactionHash, saveAddress,
		} = options
		const initialChunkSize = 500
		const chunkSize = 500
		const classifications: string[] = []
		const centroids: number[][] = []
		const dataCounts: number[] = []
		let numDimensions = null
		for (let [classification, centroidInfo] of Object.entries(model.centroids)) {
			classifications.push(classification)
			centroids.push(convertDataToHex(centroidInfo.centroid, this.web3, toFloat))
			dataCounts.push(centroidInfo.dataCount)
			if (numDimensions === null) {
				numDimensions = centroidInfo.centroid.length
			} else {
				if (centroidInfo.centroid.length !== numDimensions) {
					throw new Error(`Found a centroid with ${centroidInfo.centroid.length} dimensions. Expected: ${numDimensions}.`)
				}
			}
		}

		const ContractInfo = ModelDeployer.modelTypes[model.type]
		const contract = new this.web3.eth.Contract(ContractInfo.abi, undefined, { from: account })
		const pleaseAcceptKey = notify("Please accept the prompt to deploy the first class for the Nearest Centroid classifier")
		return contract.deploy({
			data: ContractInfo.bytecode,
			arguments: [[classifications[0]], [centroids[0].slice(0, initialChunkSize)], [dataCounts[0]]],
		}).send({
			from: account,
			// Block gas limit by most miners as of October 2019.
			gas: this.gasLimit,
		}).on('transactionHash', transactionHash => {
			dismissNotification(pleaseAcceptKey)
			notify(`Submitted the model with transaction hash: ${transactionHash}. Please wait for a deployment confirmation.`)
			saveTransactionHash('model', transactionHash)
		}).on('error', err => {
			dismissNotification(pleaseAcceptKey)
			notify("Error deploying the model", { variant: 'error' })
			throw err
		}).then(async newContractInstance => {
			// Set up each class.
			const addClassPromises = []
			for (let i = 1; i < classifications.length; ++i) {
				addClassPromises.push(new Promise((resolve, reject) => {
					const notification = notify(`Please accept the prompt to create the "${classifications[i]}" class`)
					newContractInstance.methods.addClass(centroids[i].slice(0, initialChunkSize), classifications[i], dataCounts[i]).send({
						from: account,
						// Block gas limit by most miners as of October 2019.
						gas: this.gasLimit,
					}).on('transactionHash', () => {
						dismissNotification(notification)
					}).on('error', (err: any) => {
						dismissNotification(notification)
						notify(`Error creating the "${classifications[i]}" class`, { variant: 'error' })
						reject(err)
					}).then(resolve)
				}))
			}
			return Promise.all(addClassPromises).then(async _ => {
				// Extend each class.
				// Tried with promises but got weird unhelpful errors from Truffle (some were like network timeout errors).
				for (let classification = 0; classification < classifications.length; ++classification) {
					for (let j = initialChunkSize; j < centroids[classification].length; j += chunkSize) {
						const notification = notify(`Please accept the prompt to upload the values for dimensions [${j},${j + chunkSize}) for the "${classifications[classification]}" class`)
						await newContractInstance.methods.extendCentroid(
							centroids[classification].slice(j, j + chunkSize), classification).send().on('transactionHash', () => {
								dismissNotification(notification)
							}).on('error', (err: any) => {
								dismissNotification(notification)
								notify(`Error setting feature indices for [${j},${j + chunkSize}) for the "${classifications[classification]}" class`, { variant: 'error' })
								throw err
							})
					}
				}
				notify(`The model contract has been deployed to ${newContractInstance.options.address}`, { variant: 'success' })
				saveAddress('model', newContractInstance.options.address)
				return newContractInstance
			})
		})
	}

	async deployPerceptron(model: PerceptronModel, options: any): Promise<Contract> {
		const { account, toFloat,
			notify, dismissNotification,
			saveTransactionHash, saveAddress,
		} = options
		const defaultLearningRate = 0.5
		const weightChunkSize = 450
		const { classifications, featureIndices } = model
		const weights = convertDataToHex(model.weights, this.web3, toFloat)
		const intercept = convertToHex(model.intercept, this.web3, toFloat)
		const learningRate = convertToHex(model.learningRate || defaultLearningRate, this.web3, toFloat)

		if (featureIndices !== undefined && featureIndices.length !== weights.length) {
			return Promise.reject("The number of features must match the number of weights.")
		}

		const ContractInfo = ModelDeployer.modelTypes[model.type]
		const contract = new this.web3.eth.Contract(ContractInfo.abi, undefined, { from: account })
		const pleaseAcceptKey = notify(`Please accept the prompt to deploy the Perceptron classifier with the first ${Math.min(weights.length, weightChunkSize)} weights`)
		return contract.deploy({
			data: ContractInfo.bytecode,
			arguments: [classifications, weights.slice(0, weightChunkSize), intercept, learningRate],
		}).send({
			from: account,
			gas: this.gasLimit,
		}).on('transactionHash', transactionHash => {
			dismissNotification(pleaseAcceptKey)
			notify(`Submitted the model with transaction hash: ${transactionHash}. Please wait for a deployment confirmation.`)
			saveTransactionHash('model', transactionHash)
		}).on('error', err => {
			dismissNotification(pleaseAcceptKey)
			notify("Error deploying the model", { variant: 'error' })
			throw err
		}).then(async newContractInstance => {
			// Could create a batch but I was getting various errors when trying to do and could not find docs on what `execute` returns.
			const transactions = []
			// Add remaining weights.
			for (let i = weightChunkSize; i < weights.length; i += weightChunkSize) {
				let transaction: any
				if (model.type === 'dense perceptron') {
					transaction = newContractInstance.methods.initializeWeights(weights.slice(i, i + weightChunkSize))
				} else if (model.type === 'sparse perceptron') {
					transaction = newContractInstance.methods.initializeWeights(i, weights.slice(i, i + weightChunkSize))
				} else {
					throw new Error(`Unrecognized model type: "${model.type}"`)
				}
				transactions.push(new Promise((resolve, reject) => {
					// Subtract 1 from the count because the first chunk has already been uploaded.
					const notification = notify(`Please accept the prompt to upload classifier 
					weights [${i},${i + weightChunkSize}) (${i / weightChunkSize}/${Math.ceil(weights.length / weightChunkSize) - 1})`)
					transaction.send().on('transactionHash', () => {
						dismissNotification(notification)
					}).on('error', (err: any) => {
						dismissNotification(notification)
						notify(`Error setting weights classifier weights [${i},${i + weightChunkSize})`, { variant: 'error' })
						reject(err)
					}).then(resolve)
				}))
			}
			if (featureIndices !== undefined) {
				// Add feature indices to use.
				for (let i = 0; i < featureIndices.length; i += weightChunkSize) {
					transactions.push(new Promise((resolve, reject) => {
						const notification = notify(`Please accept the prompt to upload the feature indices [${i},${i + weightChunkSize})`)
						newContractInstance.methods.addFeatureIndices(featureIndices.slice(i, i + weightChunkSize)).send()
							.on('transactionHash', () => {
								dismissNotification(notification)
							}).on('error', (err: any) => {
								dismissNotification(notification)
								notify(`Error setting feature indices for [${i},${i + weightChunkSize})`, { variant: 'error' })
								reject(err)
							}).then(resolve)
					}))
				}
			}

			return Promise.all(transactions).then(_ => {
				notify(`The model contract has been deployed to ${newContractInstance.options.address}`, { variant: 'success' })
				saveAddress('model', newContractInstance.options.address)
				return newContractInstance
			})
		})
	}

	/**
	 * @returns The contract for the model, an instance of `Classifier64`
	 * along with the the total amount of gas used to deploy the model.
	 */
	async deployModel(model: Model, options: any): Promise<Contract> {
		if (options.toFloat === undefined) {
			options.toFloat = ModelDeployer.toFloat
		}
		if (options.notify === undefined) {
			options.notify = (() => { })
		}
		if (options.dismissNotification === undefined) {
			options.dismissNotification = (() => { })
		}
		if (options.saveAddress === undefined) {
			options.saveAddress = (() => { })
		}
		if (options.saveTransactionHash === undefined) {
			options.saveTransactionHash = (() => { })
		}

		switch (model.type.toLocaleLowerCase('en')) {
			case 'dense perceptron':
			case 'sparse perceptron':
			case 'perceptron':
				return this.deployPerceptron(model as PerceptronModel, options)
			case 'naive bayes':
				return this.deployNaiveBayes(model as NaiveBayesModel, options)
			case 'dense nearest centroid classifier':
			case 'sparse nearest centroid classifier':
			case 'nearest centroid classifier':
				return this.deployNearestCentroidClassifier(model as NearestCentroidModel, options)
			default:
				// Should not happen.
				throw new Error(`Unrecognized model type: "${model.type}"`)
		}
	}
}